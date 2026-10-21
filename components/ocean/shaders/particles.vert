// ---------------------------------------------------------------------------
// Plankton particles — vertex stage.
//
// Each point is one plankton cell near the surface. It is invisible until
// something excites it:
//   • a breaking crest passes (Gerstner Jacobian at its position, now and a
//     moment ago — so it keeps glowing briefly after the crest has moved on),
//   • the interaction field's glow energy (pointer wakes, fish),
//   • a splash nearby (and the closest ones are thrown up as glowing spray),
//   • rarely, a spontaneous flash.
//
// Particles tile a square domain around the boat (`position.xy` is the cell's
// home inside one tile), so they are fixed in the world and infinite in
// every direction. Their "depth" never moves them under the opaque water;
// it only makes deeper cells dimmer, softer and bluer.
// ---------------------------------------------------------------------------
#include <ocean_common>
#include <ocean_noise>
#include <ocean_waves>
#include <ocean_glow>
#include <ocean_ripple>

#define MAX_SPLASHES 4

attribute vec4 aRandom;           // (flash phase, flash rate, size, spray chance)

uniform float uParticleDomain;    // tile size, metres
uniform float uParticleDepth;     // max depth below the surface, metres
uniform float uParticleSize;
uniform float uParticleBrightness;
uniform float uParticleSparkle;
uniform float uViewportHeight;    // drawing-buffer height in pixels
uniform vec4 uSplashes[MAX_SPLASHES]; // (x, z, start time, strength)

varying vec3 vColor;
varying float vSoftness;

void main() {
  // --- Where is this cell? --------------------------------------------------
  // Drift with the surface current plus a slow individual wander.
  vec2 home = position.xy * uParticleDomain + uCurrent * uTime
            + 0.35 * vec2(sin(uTime * 0.21 + aRandom.x * 6.3), cos(uTime * 0.17 + aRandom.y * 6.3));
  // Wrap into the tile centred on the boat.
  vec2 local = (fract((home - uOrigin) / uParticleDomain + 0.5) - 0.5) * uParticleDomain;
  vec2 rest = uOrigin + local;
  float depth = position.z * uParticleDepth;
  float depthFade = exp(-depth * 1.6);

  // Fade out towards the tile border so wrapping never pops.
  float edgeFade = 1.0 - smoothstep(0.3, 0.5, max(abs(local.x), abs(local.y)) / uParticleDomain);

  // --- Surface position --------------------------------------------------------
  WaveSample w = gerstnerSample(rest, 0.0, 0.0);
  vec3 world = vec3(rest.x, 0.0, rest.y) + w.displacement;
  vec4 ripple = rippleState(world.xz);
  world.y += ripple.r * uRippleDisplacement + 0.05;

  // --- Excitation ---------------------------------------------------------------
  // Crest now, and 0.35 s ago at reduced weight: a short afterglow.
  float crestNow = smoothstep(uGlowCrestThreshold - 0.05, uGlowCrestThreshold + 0.3, 1.0 - w.jacobian);
#if OCEAN_QUALITY >= 1
  WaveSample wPast = gerstnerSample(rest, -0.35, 0.0);
  float crestPast = smoothstep(uGlowCrestThreshold - 0.05, uGlowCrestThreshold + 0.3, 1.0 - wPast.jacobian);
  float crest = max(crestNow, crestPast * 0.6);
#else
  float crest = crestNow;
#endif

  float stirred = ripple.b;

  // Rare spontaneous flash: a very sharp peak of a slow sine.
  float flash = pow(max(sin(uTime * (0.4 + aRandom.y * 0.9) + aRandom.x * 40.0), 0.0), 60.0) * uParticleSparkle;

  // Plankton patches: more cells live (and flash) inside them.
  float density = planktonField(rest, uTime, 2.0).x;

  // Splashes: flare + spray.
  float flare = 0.0;
  vec3 spray = vec3(0.0);
  for (int i = 0; i < MAX_SPLASHES; i++) {
    vec4 s = uSplashes[i];
    float age = uTime - s.z;
    if (age < 0.0 || age > 3.0) continue;
    vec2 off = world.xz - s.xy;
    float dist = length(off);
    float reach = 2.2 + age * 2.0;  // the glow spreads with the rings
    flare += s.w * exp(-age * 1.6) * (1.0 - smoothstep(0.0, reach, dist));
    // The cells right at the impact are thrown up and fall back (ballistic).
    if (dist < 1.4 && aRandom.w < 0.6 && age < 1.2) {
      float v0 = (2.2 + 2.6 * aRandom.y) * s.w;
      float y = v0 * age - 4.9 * age * age;
      if (y > 0.0) {
        vec2 dir = dist > 1e-3 ? off / dist : vec2(1.0, 0.0);
        spray = vec3(dir.x, 0.0, dir.y) * age * (0.6 + 1.8 * aRandom.z) + vec3(0.0, y, 0.0);
        flare += 2.0 * s.w;
      }
    }
  }
  world += spray;

  float excite = crest * 1.6 + stirred * 1.3 + flare + flash * (0.4 + density);
  float brightness = excite * (0.35 + 0.65 * density) * depthFade * edgeFade * uParticleBrightness;

  // Dark particles are skipped entirely (no rasterisation, no fill cost).
  if (brightness < 0.01) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec3(0.0);
    vSoftness = 0.0;
    return;
  }

  vec4 mv = viewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mv;

  // Perspective size of a ~4 cm glow (deeper cells look bigger and softer).
  float worldSize = (0.03 + 0.05 * aRandom.z) * (1.0 + depth * 0.8) * uParticleSize;
  float px = worldSize * projectionMatrix[1][1] * 0.5 * uViewportHeight / max(-mv.z, 0.1);
  // The sprite gaussian is ~1/7 of the sprite wide: below ~3.5 px it is
  // narrower than a pixel and flickers. Clamp and keep the energy constant.
  float minPx = 3.5 * uPixelRatio;
  float size = max(px, minPx);
  brightness *= min((px * px) / (size * size), 1.0);
  gl_PointSize = min(size, 24.0 * uPixelRatio);

  // Shallow cells: the cyan → teal of the patches; deeper ones lean a little blue.
  vec3 tint = mix(uGlowColorA, uGlowColorB, density * 0.5);
  tint = mix(tint, uGlowDeep, clamp(depth / max(uParticleDepth, 1e-3), 0.0, 1.0) * 0.3);
  vColor = tint * brightness * 3.0;
  vSoftness = clamp(depth / max(uParticleDepth, 1e-3), 0.0, 1.0);
}
