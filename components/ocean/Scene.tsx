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
      last = Math.max(last + interval, now - interval);
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
 * sits above / below the bounds, and moves a 0..1 factor that we map to the
 * pixel ratio (the cheapest knob). Only when the factor is already at its
 * floor and fps is still too low does the quality tier step down (particles,
 * ripple resolution, bloom levels, shader detail); likewise it only steps up
 * from a saturated factor. After a few genuine direction reversals it stops
 * adapting and keeps whatever it has, so it cannot oscillate forever.
 *
 * Bounds are absolute: drei's fps estimate reads about one frame high, and
 * its "refreshrate" is just the highest fps it has seen, not the display's.
 */
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
  const control = useRef({ previousFactor: 0.5, lastDirection: 0, reversals: 0, frozen: false, tier });
  control.current.tier = tier;

  const onStep = (direction: 1 | -1, api: PerformanceMonitorApi) => {
    const c = control.current;
    if (c.frozen) {
      api.factor = c.previousFactor; // ignore: keep the settled DPR
      return;
    }
    if (c.lastDirection !== 0 && direction !== c.lastDirection && ++c.reversals >= 4) {
      c.frozen = true;
      api.factor = c.previousFactor;
      return;
    }
    c.lastDirection = direction;
    if (direction < 0 && c.previousFactor <= 0 && c.tier > 0) setTier((c.tier - 1) as QualityTier);
    if (direction > 0 && c.previousFactor >= 1 && c.tier < device.maxTier) setTier((c.tier + 1) as QualityTier);
    c.previousFactor = api.factor;
  };

  return (
    <PerformanceMonitor
      factor={0.5}
      step={0.15}
      flipflops={Infinity}
      bounds={() => (device.mobile ? [28, 50] : [45, 56])}
      onIncline={(api) => onStep(1, api)}
      onDecline={(api) => onStep(-1, api)}
      onChange={({ factor }) => setDpr(dprFor(device, factor))}
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
