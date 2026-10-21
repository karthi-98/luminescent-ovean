import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { RippleSim } from './RippleSim';
import { useOcean, type OceanState } from './state';
import type { SampleFilter, SurfaceSample } from './waves';

/**
 * Movement under this many pixels between press and release counts as a tap/click.
 * Tap duration uses event.timeStamp (when the input happened), so a busy
 * frame (e.g. a shader compile) can't turn a quick tap into a "long press".
 */
const TAP_SLOP_PX = 8;
const TAP_MAX_MS = 350;
/** Strokes fade out this long after the pointer stops moving on screen (longer on slow frames). */
const ACTIVITY_MS = 140;
/** Never look further than this along a ray, metres. */
const MAX_RAY = 90;

interface PointerState {
  /** Normalised device coordinates of the primary pointer. */
  ndc: THREE.Vector2;
  /** Pointer is over (mouse/pen hover) or on (one finger) the water and may draw. */
  active: boolean;
  /** The pointer moved on screen since the last frame. */
  moved: boolean;
  /** performance.now() of the last on-screen movement. */
  lastMove: number;
  downX: number;
  downY: number;
  downTime: number;
  dragging: boolean;
  touches: Set<number>;
  /** A second finger joined this touch gesture: no drawing or tapping until all fingers lift. */
  multi: boolean;
  /** Taps waiting to become splashes, NDC. */
  tapQueued: boolean;
  tap: THREE.Vector2;
}

/** Reused for every ray-cast sample (no allocations per frame). */
const RAY_FILTER: SampleFilter = { footprint: 0 };

/**
 * Height of the ray above the sea at distance s along it. The sea height is
 * sampled with the same level-of-detail fade the water vertex shader applies
 * at that distance from the boat, so the hit lands on the surface that is
 * actually drawn.
 */
function rayGap(ocean: OceanState, origin: THREE.Vector3, dir: THREE.Vector3, s: number, sample: SurfaceSample) {
  const x = origin.x + dir.x * s;
  const z = origin.z + dir.z * s;
  const r = Math.hypot(x - ocean.boat.x, z - ocean.boat.y);
  RAY_FILTER.footprint = Math.max(ocean.grid.minSpacing, r * ocean.grid.growth);
  return origin.y + dir.y * s - ocean.waves.sample(x, z, ocean.time, sample, RAY_FILTER).height;
}

/**
 * Intersects a camera ray with the animated sea surface (CPU Gerstner mirror).
 * Marches from where the ray could first touch the highest possible crest to
 * where it must be below the deepest trough until the sign of the gap flips,
 * then refines the bracket by bisection. (A plain plane iteration does not
 * converge for grazing rays: the gain is surface slope × distance / height.)
 */
function intersectWater(
  ocean: OceanState,
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  sample: SurfaceSample,
  out: THREE.Vector3,
): boolean {
  if (dir.y > -0.003) return false; // at or above the horizon: no hit
  const maxH = ocean.waves.maxHeight + 0.3;
  const down = -dir.y;
  let s0 = Math.max(0, (origin.y - maxH) / down);
  const sEnd = Math.min(MAX_RAY, (origin.y + maxH) / down);
  let g0 = rayGap(ocean, origin, dir, s0, sample);
  if (g0 <= 0) {
    out.set(origin.x + dir.x * s0, origin.y + dir.y * s0, origin.z + dir.z * s0);
    return true;
  }
  while (s0 < sEnd) {
    const s1 = Math.min(s0 + Math.max(0.25, s0 * 0.04), sEnd);
    const g1 = rayGap(ocean, origin, dir, s1, sample);
    if (g1 <= 0) {
      let lo = s0;
      let hi = s1;
      let glo = g0;
      let ghi = g1;
      for (let i = 0; i < 6; i++) {
        const mid = (lo + hi) * 0.5;
        const gm = rayGap(ocean, origin, dir, mid, sample);
        if (gm > 0) {
          lo = mid;
          glo = gm;
        } else {
          hi = mid;
          ghi = gm;
        }
      }
      const s = lo + ((hi - lo) * glo) / Math.max(glo - ghi, 1e-6);
      out.set(origin.x + dir.x * s, origin.y + dir.y * s, origin.z + dir.z * s);
      return true;
    }
    s0 = s1;
    g0 = g1;
  }
  return false;
}

/** Inside the part of the ripple domain where strokes are fully visible? */
function inDomain(v: THREE.Vector3, boat: THREE.Vector2, half: number): boolean {
  return Math.abs(v.x - boat.x) < half && Math.abs(v.z - boat.y) < half;
}

/**
 * Pointer / touch → glowing water.
 *
 * - Mouse and pen: hovering over the water draws a glowing wake; dragging
 *   looks around (no wake while dragging); a click/tap splashes.
 * - Touch: one finger draws on the water, a tap splashes, two fingers look
 *   around (and nothing is drawn or splashed until every finger has lifted).
 *
 * Owns the RippleSim and steps it every frame, centred on the boat.
 */
export function Interaction({ resolution }: { resolution: number }) {
  const ocean = useOcean();
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);

  const sim = useMemo(() => new RippleSim(gl, ocean.uniforms, resolution), [gl, ocean]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => sim.dispose(), [sim]);
  useEffect(() => sim.setResolution(resolution), [sim, resolution]);
  useEffect(() => {
    ocean.ripple = sim;
    ocean.debug.ripple = sim;
    return () => {
      if (ocean.ripple === sim) ocean.ripple = null;
    };
  }, [ocean, sim]);

  const pointer = useMemo<PointerState>(
    () => ({
      ndc: new THREE.Vector2(),
      active: false,
      moved: false,
      lastMove: -Infinity,
      downX: 0,
      downY: 0,
      downTime: 0,
      dragging: false,
      touches: new Set(),
      multi: false,
      tapQueued: false,
      tap: new THREE.Vector2(),
    }),
    [],
  );

  // --- DOM events (outside React: no re-renders) ---------------------------
  useEffect(() => {
    ocean.debug.pointer = pointer;
    const el = gl.domElement;
    const toNdc = (e: PointerEvent, target: THREE.Vector2) => {
      const rect = el.getBoundingClientRect();
      target.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    };

    const onMove = (e: PointerEvent) => {
      const touch = e.pointerType === 'touch';
      if (touch && !pointer.touches.has(e.pointerId)) return;
      toNdc(e, pointer.ndc);
      pointer.moved = true;
      pointer.lastMove = performance.now(); // handler time: compared against frame time below
      if (Math.hypot(e.clientX - pointer.downX, e.clientY - pointer.downY) > TAP_SLOP_PX) pointer.dragging = true;
      // Mouse / pen: hover draws, a pressed button looks around.
      // Touch: exactly one finger, and no second finger during this gesture.
      pointer.active = touch ? pointer.touches.size === 1 && !pointer.multi : e.buttons === 0;
    };

    const onDown = (e: PointerEvent) => {
      const touch = e.pointerType === 'touch';
      if (!touch && e.button !== 0) return;
      if (touch) {
        pointer.touches.add(e.pointerId);
        if (pointer.touches.size > 1) pointer.multi = true;
      }
      // Only the first contact of a gesture starts the tap timer / slop test.
      if (!touch || pointer.touches.size === 1) {
        toNdc(e, pointer.ndc);
        pointer.downX = e.clientX;
        pointer.downY = e.clientY;
        pointer.downTime = e.timeStamp;
        pointer.dragging = false;
      }
      pointer.active = touch && pointer.touches.size === 1 && !pointer.multi;
      pointer.lastMove = performance.now();
      ocean.notifyInteraction();
    };

    const onUp = (e: PointerEvent) => {
      const touch = e.pointerType === 'touch';
      if (touch && !pointer.touches.has(e.pointerId)) return;
      const isTap =
        !pointer.dragging &&
        !(touch && pointer.multi) &&
        e.timeStamp - pointer.downTime < TAP_MAX_MS &&
        (touch || e.button === 0);
      if (isTap) {
        toNdc(e, pointer.tap);
        pointer.tapQueued = true;
      }
      if (touch) {
        pointer.touches.delete(e.pointerId);
        if (pointer.touches.size === 0) pointer.multi = false;
        pointer.active = false;
      } else {
        // A mouse keeps hovering; a pen may leave range (its next hover move re-activates it).
        pointer.active = e.pointerType === 'mouse';
      }
      pointer.dragging = false;
    };

    const onLeave = (e: PointerEvent) => {
      if (e.pointerType === 'touch') {
        pointer.touches.delete(e.pointerId);
        if (pointer.touches.size === 0) pointer.multi = false;
      }
      pointer.active = false;
    };

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onLeave);
    el.addEventListener('pointerleave', onLeave);
    return () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onLeave);
      el.removeEventListener('pointerleave', onLeave);
    };
  }, [gl, ocean, pointer]);

  // --- Per frame: ray-cast, feed the simulation, step it --------------------
  const scratch = useMemo(
    () => ({
      origin: new THREE.Vector3(),
      dir: new THREE.Vector3(),
      hit: new THREE.Vector3(),
      last: new THREE.Vector3(),
      lastNdc: new THREE.Vector2(),
      hasLast: false,
      sample: { height: 0, nx: 0, ny: 1, nz: 0 } as SurfaceSample,
      settings: { worldSize: 72, waveSpeed: 2.6, damping: 0.6, glowLifetime: 2, diffusion: 0.1, motionGlow: 0.25 },
    }),
    [],
  );

  const castRay = (ndc: THREE.Vector2, out: THREE.Vector3) => {
    camera.updateMatrixWorld();
    scratch.origin.setFromMatrixPosition(camera.matrixWorld);
    scratch.dir.set(ndc.x, ndc.y, 0.5).unproject(camera).sub(scratch.origin).normalize();
    return intersectWater(ocean, scratch.origin, scratch.dir, scratch.sample, out);
  };

  useFrame((_, delta) => {
    const dt = Math.min(delta, 1 / 20);
    const p = ocean.params.ripple;
    const half = p.worldSize * 0.45;

    // Wake: only while the pointer actually moves on screen (not when the
    // waves or the bobbing camera move under a still pointer); strength
    // follows how fast it moves across the water.
    const activityWindow = Math.max(ACTIVITY_MS, delta * 1000 * 2.5);
    const activity = 1 - Math.min((performance.now() - pointer.lastMove) / activityWindow, 1);
    if (pointer.active && activity > 0) {
      if (castRay(pointer.ndc, scratch.hit) && inDomain(scratch.hit, ocean.boat, half)) {
        // Connect to the previous sample unless the pointer jumped (e.g. a new
        // touch elsewhere). Judged on screen, so it holds at any frame rate.
        if (pointer.moved && scratch.hasLast && pointer.ndc.distanceTo(scratch.lastNdc) < 0.6) {
          const speed = scratch.hit.distanceTo(scratch.last) / Math.max(dt, 1e-3);
          const push = THREE.MathUtils.smoothstep(speed, 0.05, 2.5) * activity;
          if (push > 0.01) {
            sim.addStroke(
              scratch.last.x,
              scratch.last.z,
              scratch.hit.x,
              scratch.hit.z,
              p.brushRadius,
              0.05 * p.strokeStrength * (0.5 + 0.5 * push),
              1.6 * p.strokeStrength * (0.5 + 0.5 * push),
            );
            ocean.notifyInteraction(); // hovering counts as touching the water
          }
        }
        scratch.last.copy(scratch.hit);
        scratch.lastNdc.copy(pointer.ndc);
        scratch.hasLast = true;
      } else {
        // Off the water (sky, or beyond the domain): break the stroke so that
        // coming back does not draw a bar from the exit point.
        scratch.hasLast = false;
      }
    } else {
      scratch.hasLast = false;
    }
    pointer.moved = false;

    // Tap / click: splash.
    if (pointer.tapQueued) {
      pointer.tapQueued = false;
      if (castRay(pointer.tap, scratch.hit) && inDomain(scratch.hit, ocean.boat, half)) {
        sim.addSplash(scratch.hit.x, scratch.hit.z, p.splashRadius, 0.12 * p.splashStrength, 1.2 * p.splashStrength);
        ocean.addSplash(scratch.hit.x, scratch.hit.z, p.splashStrength);
      }
    }

    const settings = scratch.settings;
    settings.worldSize = p.worldSize;
    settings.waveSpeed = p.waveSpeed;
    settings.damping = p.damping;
    settings.glowLifetime = p.glowLifetime;
    settings.diffusion = p.diffusion;
    settings.motionGlow = p.motionGlow;
    sim.update(dt, ocean.boat.x, ocean.boat.y, settings);
  }, -40);

  return null;
}
