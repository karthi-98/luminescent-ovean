'use client';

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bloom, ChromaticAberration, EffectComposer, Noise, ToneMapping, Vignette } from '@react-three/postprocessing';
import { BlendFunction, ToneMappingMode } from 'postprocessing';
import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { CameraRig } from './CameraRig';
import { detectDevice } from './device';
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
    ocean.time += Math.min(delta, 1 / 20);
    ocean.uniforms.uTime.value = ocean.time;
    ocean.uniforms.uPixelRatio.value = state.gl.getPixelRatio();
  }, -100);
  return null;
}

/**
 * Post-processing chain (all HDR until ToneMapping):
 *   Bloom (only what is brighter than the threshold — in practice the
 *   plankton glow, glints and the moon) → ACES Filmic → a hint of radial
 *   chromatic aberration → vignette → soft-light film grain (zero-mean, so it
 *   dithers the dark sky gradient without lifting the blacks).
 * Lower quality tiers drop MSAA, bloom mip levels and the cosmetic passes.
 */
function PostFX({ tier }: { tier: QualityTier }) {
  const ocean = useOcean();
  const gl = useThree((s) => s.gl);
  const p = ocean.params.post;
  const caOffset = useMemo(() => new THREE.Vector2(p.chromaticAberration, p.chromaticAberration), [p.chromaticAberration]);

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
      {tier > 0 ? (
        <ChromaticAberration offset={caOffset} radialModulation modulationOffset={0.3} />
      ) : (
        <></>
      )}
      <Vignette offset={0.32} darkness={p.vignette} />
      {tier > 0 ? <Noise premultiply={false} blendFunction={BlendFunction.SOFT_LIGHT} opacity={p.grain} /> : <></>}
    </EffectComposer>
  );
}

export interface SceneProps {
  ocean: OceanState;
}

export default function Scene({ ocean }: SceneProps) {
  const { camera, water } = ocean.params;
  const [device] = useState(detectDevice);
  const [tier] = useState<QualityTier>(() => (device.mobile ? 1 : 2));
  const grid = {
    segments: device.mobile ? 160 : 256,
    minSpacing: device.mobile ? 0.16 : 0.12,
    radius: water.gridRadius,
  };
  return (
    <Canvas
      className="ocean-canvas"
      dpr={device.dpr}
      camera={{ fov: camera.fov, near: camera.near, far: camera.far, position: [0, camera.height, 0] }}
      gl={{
        antialias: false,
        alpha: false,
        stencil: false,
        powerPreference: 'high-performance',
        toneMapping: THREE.ACESFilmicToneMapping,
        outputColorSpace: THREE.SRGBColorSpace,
      }}
      onCreated={({ gl }) => gl.setClearColor('#000000', 1)}
    >
      <OceanContext.Provider value={ocean}>
        <Heartbeat />
        <CameraRig />
        <Sky />
        <Water grid={grid} />
        <Interaction resolution={ocean.params.ripple.resolution[device.mobile ? 1 : 2]} />
        {ocean.params.plankton.enabled && (
          <Plankton
            capacity={ocean.params.plankton.count[device.mobile ? 1 : 2]}
            count={ocean.params.plankton.count[device.mobile ? 1 : 2]}
          />
        )}
        {ocean.params.life.enabled && <UnderwaterLife />}
        <PostFX tier={tier} />
      </OceanContext.Provider>
    </Canvas>
  );
}
