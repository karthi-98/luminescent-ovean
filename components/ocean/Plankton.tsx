import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { shaders } from './shaders';
import { useOcean, type QualityTier } from './state';

export interface PlanktonProps {
  /** Particles allocated (the maximum any quality tier will draw). */
  capacity: number;
  /** Particles drawn right now (adaptive quality lowers this without reallocating). */
  count: number;
  tier: QualityTier;
}

function createPlanktonGeometry(capacity: number): THREE.BufferGeometry {
  // position = (home u, home v, depth fraction); aRandom = (phase, rate, size, spray chance)
  const position = new Float32Array(capacity * 3);
  const random = new Float32Array(capacity * 4);
  let seed = 0x9e3779b9;
  const rand = () => {
    // xorshift32: deterministic, allocation-free
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  for (let i = 0; i < capacity; i++) {
    position[i * 3] = rand();
    position[i * 3 + 1] = rand();
    // More cells close to the surface than deep down.
    position[i * 3 + 2] = Math.pow(rand(), 1.6);
    random[i * 4] = rand();
    random[i * 4 + 1] = rand();
    random[i * 4 + 2] = rand();
    random[i * 4 + 3] = rand();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('aRandom', new THREE.BufferAttribute(random, 4));
  // Positions are computed on the GPU around the boat: never cull.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return geometry;
}

/**
 * GPU plankton: tens of thousands of points that stay dark until a crest,
 * a wake, a splash or a fish excites them (see shaders/particles.vert).
 */
export function Plankton({ capacity, count, tier }: PlanktonProps) {
  const ocean = useOcean();
  const geometry = useMemo(() => createPlanktonGeometry(capacity), [capacity]);
  useEffect(() => {
    geometry.setDrawRange(0, Math.min(count, capacity));
  }, [geometry, count, capacity]);

  const local = useMemo(
    () => ({
      uParticleDomain: { value: 64 },
      uParticleDepth: { value: 1.4 },
      uParticleSize: { value: 1 },
      uParticleBrightness: { value: 1 },
      uParticleSparkle: { value: 0.35 },
      uViewportHeight: { value: 1080 },
    }),
    [],
  );

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        name: 'OceanPlankton',
        uniforms: { ...ocean.uniforms, ...local },
        vertexShader: shaders.particles.vertex,
        fragmentShader: shaders.particles.fragment,
        defines: { OCEAN_QUALITY: 1 },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [ocean, local],
  );

  useEffect(() => {
    const quality = tier === 0 ? 0 : 1;
    if (material.defines.OCEAN_QUALITY !== quality) {
      material.defines.OCEAN_QUALITY = quality;
      material.needsUpdate = true;
    }
  }, [material, tier]);

  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);

  const size = useMemo(() => new THREE.Vector2(), []);
  useFrame(({ gl }) => {
    const p = ocean.params.plankton;
    local.uParticleDomain.value = p.worldSize;
    local.uParticleDepth.value = p.depth;
    local.uParticleSize.value = p.size;
    local.uParticleBrightness.value = p.brightness;
    local.uParticleSparkle.value = p.sparkle;
    local.uViewportHeight.value = gl.getDrawingBufferSize(size).y;
  });

  return <points geometry={geometry} material={material} frustumCulled={false} renderOrder={10} />;
}
