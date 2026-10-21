// Star field: ~3000 points on the sky sphere. Brightness, size, colour and
// twinkle rate are per-star attributes generated on the CPU.
#include <ocean_common>
#include <ocean_sky>

attribute float aSize;
attribute float aBrightness;
attribute vec2 aTwinkle;   // (rate, phase)
attribute vec3 aColor;

uniform float uStarSize;
uniform float uStarBrightness;
uniform float uTwinkle;

varying vec3 vColor;
varying float vIntensity;

void main() {
  vec3 dir = normalize(position);

  // Extinction: stars dim and vanish in the thick air just above the horizon.
  float horizonFade = smoothstep(-0.005, 0.18, dir.y);
  // Stars drown in the moon's corona.
  float moonFade = smoothstep(0.04, 0.4, angleBetween(dir, uMoonDir));

  // Scintillation: two detuned sines give an irregular flicker. Low stars
  // shine through more turbulent air, so they twinkle harder.
  float t1 = sin(uTime * aTwinkle.x + aTwinkle.y) * 0.5 + 0.5;
  float t2 = sin(uTime * aTwinkle.x * 2.37 + aTwinkle.y * 3.1) * 0.5 + 0.5;
  float depth = uTwinkle * mix(1.0, 0.45, dir.y);
  float scint = 1.0 - depth * (1.0 - t1 * t2);

  vIntensity = aBrightness * uStarBrightness * horizonFade * moonFade * scint;
  vColor = aColor;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);

  // The sprite's gaussian is ~1/6 of the sprite wide, so below ~3 px it is
  // narrower than a pixel and twinkles with sub-pixel motion. Clamp the size
  // (σ ≥ ~0.5 px) and compensate the brightness so the energy is unchanged.
  float size = aSize * uStarSize * uPixelRatio;
  float clamped = max(size, 3.2 * uPixelRatio);
  vIntensity *= (size * size) / (clamped * clamped);
  gl_PointSize = clamped;
}
