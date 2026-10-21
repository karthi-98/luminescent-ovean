'use client';

import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { CameraRig } from './CameraRig';
import { Sky } from './Sky';
import { OceanContext, useOcean, type OceanState } from './state';

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

export interface SceneProps {
  ocean: OceanState;
}

export default function Scene({ ocean }: SceneProps) {
  const { camera } = ocean.params;
  return (
    <Canvas
      className="ocean-canvas"
      dpr={[1, 2]}
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
      </OceanContext.Provider>
    </Canvas>
  );
}
