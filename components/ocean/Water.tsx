import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { shaders } from './shaders';
import { useOcean, type QualityTier } from './state';

export interface GridSpec {
  /** Vertices per ring. */
  segments: number;
  /** Ring spacing right under the camera, metres. */
  minSpacing: number;
  /** Outer radius, metres. */
  radius: number;
}

/**
 * Builds a flat polar grid: a centre vertex, then rings whose spacing is
 * `minSpacing` close in and grows proportionally to the radius further out
 * (keeping each cell roughly square: Δr ≈ 2πr / segments). The result is
 * very dense where the camera looks down at the water and sparse at the
 * horizon, ~85k vertices for 256 segments out to 6 km.
 */
export function createRadialGrid({ segments, minSpacing, radius }: GridSpec): THREE.BufferGeometry {
  const growth = (2 * Math.PI) / segments;
  const radii: number[] = [];
  for (let r = minSpacing; r < radius; r += Math.max(minSpacing, r * growth)) radii.push(r);
  radii.push(radius);

  const ringCount = radii.length;
  const vertexCount = 1 + ringCount * segments;
  const positions = new Float32Array(vertexCount * 3); // y stays 0: the vertex shader displaces
  for (let j = 0; j < ringCount; j++) {
    const r = radii[j];
    // Rotate every other ring by half a cell so the triangles don't line up radially.
    const offset = (j % 2) * 0.5;
    for (let i = 0; i < segments; i++) {
      const a = ((i + offset) / segments) * Math.PI * 2;
      const v = 1 + j * segments + i;
      positions[v * 3] = Math.cos(a) * r;
      positions[v * 3 + 2] = Math.sin(a) * r;
    }
  }

  const indexCount = segments * 3 + (ringCount - 1) * segments * 6;
  const indices = vertexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
  let k = 0;
  // Centre fan. Winding is chosen so the faces point up (+Y).
  for (let i = 0; i < segments; i++) {
    indices[k++] = 0;
    indices[k++] = 1 + ((i + 1) % segments);
    indices[k++] = 1 + i;
  }
  for (let j = 0; j < ringCount - 1; j++) {
    const inner = 1 + j * segments;
    const outer = inner + segments;
    for (let i = 0; i < segments; i++) {
      const i1 = (i + 1) % segments;
      const a = inner + i;
      const b = inner + i1;
      const c = outer + i;
      const d = outer + i1;
      indices[k++] = a;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = d;
      indices[k++] = c;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  // The grid travels with the camera and is displaced on the GPU; a huge
  // bounding sphere keeps three.js from ever culling it.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius * 2);
  return geometry;
}

export interface WaterProps {
  grid: GridSpec;
  tier: QualityTier;
}

/** The ocean surface: camera-following radial grid + water shaders. */
export function Water({ grid, tier }: WaterProps) {
  const ocean = useOcean();
  const { segments, minSpacing, radius } = grid;

  const geometry = useMemo(
    () => createRadialGrid({ segments, minSpacing, radius }),
    [segments, minSpacing, radius],
  );

  const gridSpacing = useMemo(() => ({ value: new THREE.Vector2() }), []);
  gridSpacing.value.set(minSpacing, (2 * Math.PI) / segments);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        name: 'OceanWater',
        uniforms: { ...ocean.uniforms, uGridSpacing: gridSpacing },
        vertexShader: shaders.water.vertex,
        fragmentShader: shaders.water.fragment,
        defines: { OCEAN_QUALITY: 1 },
      }),
    [ocean, gridSpacing],
  );

  // Shader detail follows the quality tier (recompiles once per change).
  useEffect(() => {
    const quality = tier === 0 ? 0 : 1;
    if (material.defines.OCEAN_QUALITY !== quality) {
      material.defines.OCEAN_QUALITY = quality;
      material.needsUpdate = true;
    }
  }, [material, tier]);

  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);

  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={0} />;
}
