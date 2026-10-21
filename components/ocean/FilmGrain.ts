import { wrapEffect } from '@react-three/postprocessing';
import { BlendFunction, Effect } from 'postprocessing';
import * as THREE from 'three';

/**
 * Film grain that stays clean forever.
 *
 * postprocessing's NoiseEffect hashes `uv * time` with a sin() hash, which
 * degrades into visible diagonal stripes as the clock grows. This one hashes
 * the integer pixel coordinate and a frame counter (PCG), adds zero-mean
 * grain in gamma space (so it is even across dark and bright tones and
 * dithers the deep-blue sky gradient against 8-bit banding), and is applied
 * after tone mapping.
 */
const fragment = /* glsl */ `
uniform float uAmount;
uniform float uFrame;

uvec3 grainHash(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  uvec3 h = grainHash(uvec3(uvec2(gl_FragCoord.xy), uint(uFrame)));
  // Sum of two uniforms: a softer, triangular distribution in [-1, 1].
  float n = (float(h.x) + float(h.y)) * (1.0 / 4294967296.0) - 1.0;
  vec3 g = pow(max(inputColor.rgb, 0.0), vec3(1.0 / 2.2));
  g += n * uAmount * 0.06;
  outputColor = vec4(pow(max(g, 0.0), vec3(2.2)), inputColor.a);
}
`;

export class FilmGrainEffect extends Effect {
  constructor({ amount = 0.2 }: { amount?: number } = {}) {
    super('FilmGrainEffect', fragment, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, THREE.Uniform>([
        ['uAmount', new THREE.Uniform(amount)],
        ['uFrame', new THREE.Uniform(0)],
      ]),
    });
  }

  get amount(): number {
    return this.uniforms.get('uAmount')!.value as number;
  }

  set amount(value: number) {
    this.uniforms.get('uAmount')!.value = value;
  }

  update() {
    const frame = this.uniforms.get('uFrame')!;
    frame.value = ((frame.value as number) + 1) % 65536;
  }
}

export const FilmGrain = wrapEffect(FilmGrainEffect);
