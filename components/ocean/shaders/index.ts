import * as THREE from 'three';

import noiseChunk from './noise.glsl';
import skyChunk from './sky.glsl';

import skyVert from './sky.vert';
import skyFrag from './sky.frag';
import starsVert from './stars.vert';
import starsFrag from './stars.frag';

/**
 * Shared GLSL chunks are registered on THREE.ShaderChunk so any ShaderMaterial
 * can `#include <ocean_noise>` etc. This runs once, when the module is first
 * imported (always before a material using them is compiled).
 */
const chunks: Record<string, string> = {
  ocean_noise: noiseChunk,
  ocean_sky: skyChunk,
};

const registry = THREE.ShaderChunk as unknown as Record<string, string>;
for (const [name, source] of Object.entries(chunks)) registry[name] = source;

export const shaders = {
  sky: { vertex: skyVert, fragment: skyFrag },
  stars: { vertex: starsVert, fragment: starsFrag },
};
