import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { RippleSim } from './RippleSim';
import { useOcean, type OceanState } from './state';
import type { SurfaceSample } from './waves';

/** Movement under this many pixels between press and release counts as a tap/click. */
const TAP_SLOP_PX = 8;
const TAP_MAX_MS = 350;
/** Strokes fade out this long after the pointer stops moving on screen. */
const ACTIVITY_MS = 140;

interface PointerState {
  /** Normalised device coordinates of the primary pointer. */
  ndc: THREE.Vector2;
  /** Pointer is over (mouse) / on (touch) the water and may draw. */
  active: boolean;
  /** performance.now() of the last on-screen movement. */
  lastMove: number;
  downX: number;
  downY: number;
  downTime: number;
  dragging: boolean;
  touches: Set<number>;
  /** Taps waiting to become splashes, NDC. */
  tapQueued: boolean;
  tap: THREE.Vector2;
}

/**
 * Intersects a camera ray with the animated sea surface. The surface height
 * comes from the CPU Gerstner mirror, refined over a few plane intersections
 * (the waves are gentle, so this converges in 3–4 iterations).
 */
function intersectWater(
  ocean: OceanState,
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  sample: SurfaceSample,
  out: THREE.Vector3,
): boolean {
  if (dir.y > -0.003) return false; // looking at (or just under) the horizon: no hit
  let h = 0;
  for (let i = 0; i < 4; i++) {
    const s = (h - origin.y) / dir.y;
    if (s <= 0) return false;
    out.set(origin.x + dir.x * s, 0, origin.z + dir.z * s);
    h = ocean.waves.sample(out.x, out.z, ocean.time, sample).height;
  }
  out.y = h;
  return true;
}

/**
 * Pointer / touch → glowing water.
 *
 * - Desktop: moving the mouse over the water draws a glowing wake; dragging
 *   looks around (no wake while dragging); a click splashes.
 * - Touch: one finger draws on the water, a tap splashes, two fingers look around.
 *
 * Owns the RippleSim and steps it every frame, centred on the boat.
 */
export function Interaction({ resolution }: { resolution: number }) {
  const ocean = useOcean();
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);

  const sim = useMemo(() => new RippleSim(gl, ocean.uniforms, resolution), [gl, ocean]);
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
      lastMove: -Infinity,
      downX: 0,
      downY: 0,
      downTime: 0,
      dragging: false,
      touches: new Set(),
      tapQueued: false,
      tap: new THREE.Vector2(),
    }),
    [],
  );

  // --- DOM events (outside React: no re-renders) ---------------------------
  useEffect(() => {
    const el = gl.domElement;
    const toNdc = (e: PointerEvent, target: THREE.Vector2) => {
      const rect = el.getBoundingClientRect();
      target.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch' && !pointer.touches.has(e.pointerId)) return;
      toNdc(e, pointer.ndc);
      pointer.lastMove = performance.now();
      if (Math.hypot(e.clientX - pointer.downX, e.clientY - pointer.downY) > TAP_SLOP_PX) pointer.dragging = true;
      if (e.pointerType === 'mouse') {
        // Hover draws; a held button means the user is looking around instead.
        pointer.active = e.buttons === 0;
      } else {
        pointer.active = pointer.touches.size === 1;
      }
    };

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.pointerType === 'touch') pointer.touches.add(e.pointerId);
      toNdc(e, pointer.ndc);
      pointer.downX = e.clientX;
      pointer.downY = e.clientY;
      pointer.downTime = performance.now();
      pointer.dragging = false;
      pointer.active = e.pointerType === 'mouse' ? false : pointer.touches.size === 1;
      pointer.lastMove = performance.now();
      ocean.notifyInteraction();
    };

    const onUp = (e: PointerEvent) => {
      const isTap =
        !pointer.dragging &&
        performance.now() - pointer.downTime < TAP_MAX_MS &&
        (e.pointerType !== 'touch' || pointer.touches.size === 1);
      if (isTap && (e.pointerType !== 'mouse' || e.button === 0)) {
        toNdc(e, pointer.tap);
        pointer.tapQueued = true;
      }
      if (e.pointerType === 'touch') {
        pointer.touches.delete(e.pointerId);
        pointer.active = false;
      } else {
        pointer.active = true;
      }
      pointer.dragging = false;
    };

    const onLeave = (e: PointerEvent) => {
      if (e.pointerType === 'touch') pointer.touches.delete(e.pointerId);
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
    const inDomain = (v: THREE.Vector3) =>
      Math.abs(v.x - ocean.boat.x) < half && Math.abs(v.z - ocean.boat.y) < half;

    // Wake: strength follows how recently and how fast the pointer moved.
    const activity = 1 - Math.min((performance.now() - pointer.lastMove) / ACTIVITY_MS, 1);
    if (pointer.active && activity > 0 && castRay(pointer.ndc, scratch.hit) && inDomain(scratch.hit)) {
      // Connect to the previous sample unless the pointer jumped (e.g. a new
      // touch elsewhere). Judged on screen, so it holds at any frame rate.
      if (scratch.hasLast && pointer.ndc.distanceTo(scratch.lastNdc) < 0.6) {
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
        }
      }
      scratch.last.copy(scratch.hit);
      scratch.lastNdc.copy(pointer.ndc);
      scratch.hasLast = true;
    } else if (!pointer.active || activity <= 0) {
      scratch.hasLast = false;
    }

    // Tap / click: splash.
    if (pointer.tapQueued) {
      pointer.tapQueued = false;
      if (castRay(pointer.tap, scratch.hit) && inDomain(scratch.hit)) {
        sim.addSplash(scratch.hit.x, scratch.hit.z, p.splashRadius, 0.12 * p.splashStrength, 1.2 * p.splashStrength);
        ocean.addSplash(scratch.hit.x, scratch.hit.z, p.splashStrength);
      }
    }

    sim.update(dt, ocean.boat.x, ocean.boat.y, {
      worldSize: p.worldSize,
      waveSpeed: p.waveSpeed,
      damping: p.damping,
      glowLifetime: p.glowLifetime,
      diffusion: p.diffusion,
      motionGlow: p.motionGlow,
    });
  }, -40);

  return null;
}
