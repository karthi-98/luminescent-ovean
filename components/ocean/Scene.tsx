'use client';

import { PerformanceMonitor, type PerformanceMonitorApi } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bloom, ChromaticAberration, EffectComposer, ToneMapping, Vignette } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { CameraRig } from './CameraRig';
import { FilmGrain } from './FilmGrain';
import type { DeviceProfile } from './device';
import { Interaction } from './Interaction';
import { Plankton } from './Plankton';
import { Sky } from './Sky';
import { OceanContext, useOcean, type OceanState, type QualityTier } from './state';
import { UnderwaterLife } from './UnderwaterLife';
import { Water } from './Water';

/**
 * Advances the shared clock before anything else runs each frame. The delta
 * is clamped so a long frame (tab switch, GC pause) never makes the waves
 * or the ripple simulation jump.
 */
function Heartbeat() {
  const ocean = useOcean();
  useFrame((state, delta) => {
    ocean.tick(Math.min(delta, 1 / 20));
    ocean.uniforms.uPixelRatio.value = state.gl.getPixelRatio();
    // Smoothed fps for the debug panel.
    if (delta > 0) ocean.stats.fps += (1 / delta - ocean.stats.fps) * 0.05;
    ocean.audio?.update(ocean.time, ocean.motion.heave);
  }, -100);
  return null;
}

/**
 * Drives rendering instead of R3F's own loop (`frameloop="never"`):
 *  - caps the frame rate at `maxFps` (a 120 Hz phone would otherwise render
 *    twice as many frames as anyone can see, and get hot doing it). The
 *    schedule keeps its phase, so 75/90/144 Hz displays still average maxFps;
 *  - stops completely while the tab is hidden (rAF pauses, and we also skip
 *    explicitly), and resumes without a time jump (deltas are clamped).
 * R3F's never-mode computes delta = timestamp − previous timestamp, so the
 * timestamp is passed in seconds.
 */
function FrameDriver({ maxFps }: { maxFps: number }) {
  const advance = useThree((s) => s.advance);
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const interval = 1000 / maxFps;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden || now - last < interval - 1.5) return;
      // Keep the phase (so 75/90/144 Hz average maxFps) but never let the
      // schedule run ahead of real time (a 60.05 Hz panel would drop frames).
      last = Math.min(now, Math.max(last + interval, now - interval));
      advance(now / 1000);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [advance, maxFps]);
  return null;
}

/**
 * Post-processing chain (all HDR until ToneMapping):
 *   Bloom (only what is brighter than the threshold — in practice the
 *   plankton glow, glints and the moon) → ACES Filmic → a hint of radial
 *   chromatic aberration → vignette → film grain (zero-mean, so it dithers
 *   the dark sky gradient without lifting the blacks; see FilmGrain.ts).
 * Lower quality tiers drop MSAA, bloom mip levels and the cosmetic passes.
 */
function PostFX({ tier }: { tier: QualityTier }) {
  const ocean = useOcean();
  const gl = useThree((s) => s.gl);
  const p = ocean.params.post;
  const caOffset = useMemo(() => new THREE.Vector2(), []);
  caOffset.set(p.chromaticAberration, p.chromaticAberration);

  useEffect(() => {
    gl.toneMappingExposure = p.exposure;
  }, [gl, p.exposure]);

  return (
    <EffectComposer multisampling={tier === 2 ? 4 : 0} stencilBuffer={false}>
      <Bloom
        mipmapBlur
        luminanceThreshold={p.bloomThreshold}
        luminanceSmoothing={p.bloomSmoothing}
        intensity={p.bloomIntensity}
        radius={p.bloomRadius}
        levels={tier === 2 ? 8 : tier === 1 ? 6 : 5}
      />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      {tier > 0 ? <ChromaticAberration offset={caOffset} radialModulation modulationOffset={0.3} /> : <></>}
      <Vignette offset={0.32} darkness={p.vignette} />
      {tier > 0 ? <FilmGrain amount={p.grain} /> : <></>}
    </EffectComposer>
  );
}

/** Pixel ratio for a 0..1 quality factor within the device's DPR range (never above the screen's). */
function dprFor(device: DeviceProfile, factor: number): number {
  const [min, max] = device.dpr;
  const screen = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  const dpr = Math.round((min + (max - min) * factor) * 10) / 10;
  return Math.max(1, Math.min(dpr, screen));
}

/**
 * Adaptive quality with drei's PerformanceMonitor.
 *
 * The monitor reports "incline" / "decline" every ~2.5 s when the sampled fps
 * sits above / below the bounds, moving a 0..1 factor that maps to the pixel
 * ratio (the cheapest knob). Only when the factor is already at its floor and
 * fps is still too low does the quality tier step down (particles, ripple
 * resolution, bloom levels, shader detail). A tier only steps back up from a
 * saturated factor *and* with clear headroom, so a device doesn't bounce
 * between tiers (each switch recompiles shaders). DPR is applied here, not via
 * drei's onChange, whose change detection resets when this component re-renders.
 *
 * Two guards keep it from doing harm:
 *  - Oscillation: four direction reversals within 90 s lock *upward* moves
 *    (2 min, doubling each time). Declines still apply, so it settles on a
 *    setting that actually holds the frame rate, never on one measured too slow.
 *  - Futile reductions: if two reductions in a row that really changed DPR
 *    or tier did not raise the measured fps, the frame rate is limited
 *    elsewhere (browser power saving, a 30 Hz display, CPU-bound). Both
 *    steps are undone and declines pause (1 min, doubling each time) instead
 *    of draining quality for nothing. Two steps, not one, so vsync-quantised
 *    frame rates (30 → 60 needs a big enough cut) still get there.
 *
 * Bounds are in drei's units: its estimate counts n+1 frames over n
 * intervals, so it reads ~4 fps high (60 fps → ~64). Desktop [57, 61] ≈
 * keeps ~53+ real fps and only raises cost when it is near the 60 fps cap;
 * phones [33, 52] ≈ keep 29+ real fps.
 */
const BOUNDS = { desktop: [57, 61] as [number, number], mobile: [33, 52] as [number, number] };
/** Mean drei fps required before a tier may step up (≈ running at the 60 fps cap / with room to spare). */
const TIER_UP_FPS = { desktop: 62, mobile: 56 };

function AdaptiveQuality({
  device,
  tier,
  setTier,
  setDpr,
}: {
  device: DeviceProfile;
  tier: QualityTier;
  setTier: (t: QualityTier) => void;
  setDpr: (dpr: number) => void;
}) {
  const control = useRef({
    tier,
    factor: 0.5,
    lastDirection: 0,
    reversals: [-Infinity, -Infinity, -Infinity, -Infinity],
    reversalIndex: 0,
    upLockUntil: 0,
    upLockMs: 120_000,
    downLockUntil: 0,
    downLockMs: 60_000,
    // Futility tracking: fps before the current run of reductions, how many
    // reductions in that run did not help, and the setting to go back to.
    baseFps: 0,
    futile: 0,
    baseFactor: 0.5,
    baseTier: tier,
    pending: false,
    /** The last step was a reduction that actually changed DPR or tier. */
    lastChanged: false,
  });
  control.current.tier = tier;

  const onStep = (direction: 1 | -1, api: PerformanceMonitorApi) => {
    const c = control.current;
    const now = performance.now();
    let fps = 0;
    for (let i = 0; i < api.averages.length; i++) fps += api.averages[i];
    fps /= Math.max(api.averages.length, 1);

    // Did the previous reduction(s) help at all? (Only judged right after a
    // step that changed something: a clamped DPR step can't help by design.)
    if (direction < 0 && c.pending && c.lastChanged) {
      if (fps <= c.baseFps + 1.5) c.futile++;
      else {
        c.futile = 0;
        c.baseFps = fps;
        c.baseFactor = c.factor;
        c.baseTier = c.tier;
      }
      if (c.futile >= 2) {
        c.pending = false;
        c.futile = 0;
        c.downLockUntil = now + c.downLockMs;
        c.downLockMs = Math.min(c.downLockMs * 2, 600_000);
        c.factor = api.factor = c.baseFactor;
        if (c.baseTier !== c.tier) setTier(c.baseTier);
        setDpr(dprFor(device, c.factor));
        return;
      }
    } else if (direction > 0) {
      c.pending = false;
      c.futile = 0;
    }

    if (c.lastDirection !== 0 && direction !== c.lastDirection) {
      c.reversals[c.reversalIndex] = now;
      c.reversalIndex = (c.reversalIndex + 1) % c.reversals.length;
      // All four slots within the window → we keep flip-flopping.
      let recent = 0;
      for (let i = 0; i < c.reversals.length; i++) if (now - c.reversals[i] < 90_000) recent++;
      if (recent === c.reversals.length) {
        c.upLockUntil = now + c.upLockMs;
        c.upLockMs = Math.min(c.upLockMs * 2, 900_000);
        c.reversals.fill(-Infinity);
      }
    }
    c.lastDirection = direction;

    if ((direction > 0 && now < c.upLockUntil) || (direction < 0 && now < c.downLockUntil)) {
      api.factor = c.factor; // ignore this step
      return;
    }

    const before = dprFor(device, c.factor);
    let nextTier = c.tier;
    if (direction < 0 && c.factor <= 0 && c.tier > 0) nextTier = (c.tier - 1) as QualityTier;
    const tierUpFps = device.mobile ? TIER_UP_FPS.mobile : TIER_UP_FPS.desktop;
    if (direction > 0 && c.factor >= 1 && c.tier < device.maxTier && fps >= tierUpFps)
      nextTier = (c.tier + 1) as QualityTier;
    const dpr = dprFor(device, api.factor);
    const changed = nextTier !== c.tier || dpr !== before;
    c.lastChanged = direction < 0 && changed;
    if (direction < 0 && changed) {
      if (!c.pending) {
        // First reduction of a run: remember where we started.
        c.pending = true;
        c.baseFps = fps;
        c.baseFactor = c.factor;
        c.baseTier = c.tier;
      }
    }
    if (nextTier !== c.tier) setTier(nextTier);
    setDpr(dpr);
    c.factor = api.factor;
  };

  return (
    <PerformanceMonitor
      factor={0.5}
      step={0.15}
      flipflops={Infinity}
      bounds={() => (device.mobile ? BOUNDS.mobile : BOUNDS.desktop)}
      onIncline={(api) => onStep(1, api)}
      onDecline={(api) => onStep(-1, api)}
    />
  );
}

export interface SceneProps {
  ocean: OceanState;
  device: DeviceProfile;
  /** Fixed tier from `?quality=`; disables adaptive quality. */
  pinnedTier: QualityTier | null;
  /** Bumped by the debug panel so prop-driven parts (toggles, post) re-render. */
  revision: number;
  /** First frame is on screen (used to fade the scene in). */
  onReady?: () => void;
}

export default function Scene({ ocean, device, pinnedTier, onReady }: SceneProps) {
  const { camera, water, plankton, ripple, life } = ocean.params;
  const [autoTier, setAutoTier] = useState<QualityTier>(device.startTier);
  const tier = pinnedTier ?? autoTier;
  // The Canvas prop is the single source of truth for DPR: R3F re-applies it
  // on every render/resize, so it must carry the adaptive value.
  const [dpr, setDpr] = useState(() => dprFor(device, pinnedTier === null ? 0.5 : pinnedTier / 2));
  ocean.stats.tier = tier;
  ocean.stats.dpr = dpr;

  const grid = useMemo(
    () => ({
      segments: device.mobile ? 160 : 256,
      minSpacing: device.mobile ? 0.16 : 0.12,
      radius: water.gridRadius,
    }),
    [device.mobile, water.gridRadius],
  );

  // Allocate particles for the best tier this device may reach; lower tiers draw fewer.
  const capacity = plankton.count[device.maxTier];

  return (
    <Canvas
      className="ocean-canvas"
      frameloop="never"
      dpr={dpr}
      camera={{ fov: camera.fov, near: camera.near, far: camera.far, position: [0, camera.height, 0] }}
      gl={{
        antialias: false,
        alpha: false,
        stencil: false,
        depth: true,
        powerPreference: 'high-performance',
        toneMapping: THREE.ACESFilmicToneMapping,
        outputColorSpace: THREE.SRGBColorSpace,
      }}
      onCreated={({ gl }) => {
        gl.setClearColor('#000000', 1);
        // Two frames: shaders compile on the first, so fade in after the second.
        requestAnimationFrame(() => requestAnimationFrame(() => onReady?.()));
      }}
    >
      <OceanContext.Provider value={ocean}>
        <FrameDriver maxFps={device.maxFps} />
        {pinnedTier === null && <AdaptiveQuality device={device} tier={tier} setTier={setAutoTier} setDpr={setDpr} />}
        <Heartbeat />
        <CameraRig />
        <Sky />
        <Water grid={grid} tier={tier} />
        <Interaction resolution={ripple.resolution[tier]} />
        {plankton.enabled && <Plankton capacity={capacity} count={plankton.count[tier]} tier={tier} />}
        {life.enabled && <UnderwaterLife />}
        <PostFX tier={tier} />
      </OceanContext.Provider>
    </Canvas>
  );
}
