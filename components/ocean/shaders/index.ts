import * as THREE from 'three';

import commonChunk from './common.glsl';
import glowChunk from './glow.glsl';
import noiseChunk from './noise.glsl';
import rippleChunk from './ripple.glsl';
import skyChunk from './sky.glsl';
import wavesChunk from './waves.glsl';

import skyVert from './sky.vert';
import skyFrag from './sky.frag';
import starsVert from './stars.vert';
import starsFrag from './stars.frag';
import particlesVert from './particles.vert';
import particlesFrag from './particles.frag';
import rippleVert from './ripple.vert';
import rippleFrag from './ripple.frag';
import waterVert from './water.vert';
import waterFrag from './water.frag';

/**
 * Shared GLSL chunks are registered on THREE.ShaderChunk so any ShaderMaterial
 * can `#include <ocean_noise>` etc. This runs once, when the module is first
 * imported (always before a material using them is compiled).
 */
const chunks: Record<string, string> = {
  ocean_common: commonChunk,
  ocean_noise: noiseChunk,
  ocean_sky: skyChunk,
  ocean_waves: wavesChunk,
  ocean_glow: glowChunk,
  ocean_ripple: rippleChunk,
};

const registry = THREE.ShaderChunk as unknown as Record<string, string>;
for (const [name, source] of Object.entries(chunks)) registry[name] = source;

export const shaders = {
  sky: { vertex: skyVert, fragment: skyFrag },
  stars: { vertex: starsVert, fragment: starsFrag },
  water: { vertex: waterVert, fragment: waterFrag },
  ripple: { vertex: rippleVert, fragment: rippleFrag },
  particles: { vertex: particlesVert, fragment: particlesFrag },
};
