'use client';

import { PerformanceMonitor } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bloom, ChromaticAberration, EffectComposer, ToneMapping, Vignette } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
    const dt = Math.min(delta, 1 / 20);
    ocean.time += dt;
    ocean.uniforms.uTime.value = ocean.time;
    ocean.uniforms.uPixelRatio.value = state.gl.getPixelRatio();
    // Smoothed fps for the debug panel.
    if (delta > 0) ocean.stats.fps += (1 / delta - ocean.stats.fps) * 0.05;
    ocean.audio?.update(ocean.time, ocean.motion.heave);
  }, -100);
  return null;
}

/**
 * Drives rendering instead of R3F's own loop (`frameloop="never"`):
 *  - caps the frame rate (a 120 Hz phone would otherwise render twice as
 *    many frames as anyone can see, and get hot doing it),
 *  - stops completely while the tab is hidden (rAF pauses, and we also skip
 *    explicitly), and resumes without a time jump (deltas are clamped).
 */
function FrameDriver({ maxFps }: { maxFps: number }) {
  const advance = useThree((s) => s.advance);
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const minInterval = 1000 / maxFps - 1.5; // small tolerance for rAF jitter
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden || now - last < minInterval) return;
      last = now;
      advance(now);
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

/**
 * Adaptive quality. drei's PerformanceMonitor watches the frame rate:
 * when it drops, the pixel ratio comes down first (cheapest to change);
 * once that is at its floor, the quality tier steps down (particles, ripple
 * resolution, bloom levels, shader detail). Improvement reverses the same
 * way. After too many flip-flops it settles on the lowest settings.
 */
function AdaptiveQuality({
  device,
  tier,
  setTier,
  pinned,
}: {
  device: DeviceProfile;
  tier: QualityTier;
  setTier: (t: QualityTier) => void;
  pinned: boolean;
}) {
  const ocean = useOcean();
  const setDpr = useThree((s) => s.setDpr);
  const [minDpr, maxDpr] = device.dpr;
  const deviceDpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
  const tierRef = useRef(tier);
  tierRef.current = tier;

  const applyFactor = useCallback(
    (factor: number) => {
      const dpr = Math.min(Math.round((minDpr + (maxDpr - minDpr) * factor) * 10) / 10, deviceDpr);
      setDpr(Math.max(dpr, 1));
      ocean.stats.dpr = Math.max(dpr, 1);
    },
    [minDpr, maxDpr, deviceDpr, setDpr, ocean],
  );

  useEffect(() => applyFactor(0.5), [applyFactor]);

  if (pinned) return null;
  // Desktop aims for 60 fps; phones for a steady 30+ without heating up.
  const bounds = (refresh: number): [number, number] =>
    device.mobile ? [30, Math.min(refresh, 60) - 6] : [Math.min(refresh, 60) - 12, Math.min(refresh, 60) - 3];
  return (
    <PerformanceMonitor
      factor={0.5}
      step={0.15}
      flipflops={6}
      bounds={bounds}
      onChange={({ factor }) => applyFactor(factor)}
      onDecline={({ factor }) => {
        if (factor <= 0.05 && tierRef.current > 0) setTier((tierRef.current - 1) as QualityTier);
      }}
      onIncline={({ factor }) => {
        if (factor >= 0.95 && tierRef.current < device.maxTier) setTier((tierRef.current + 1) as QualityTier);
      }}
      onFallback={() => {
        setTier(0);
        applyFactor(0);
      }}
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
  ocean.stats.tier = tier;

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
      dpr={device.dpr[0]}
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
        <AdaptiveQuality device={device} tier={tier} setTier={setAutoTier} pinned={pinnedTier !== null} />
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
