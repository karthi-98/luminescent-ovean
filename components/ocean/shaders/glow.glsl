// ---------------------------------------------------------------------------
// ocean_glow — the bioluminescent plankton model.
//
// Light emitted by a patch of sea surface:
//
//   emission = amount of plankton            (drifting patches, planktonField)
//            × how hard it is being stirred  (ambient + crests + ripples)
//            × granular structure            (individual flashing cells)
//
// Real dinoflagellates only flash when the water around them is sheared, so
// "stirring" both brightens the glow *and* raises the fraction of cells that
// are lit (`prob` below): calm water twinkles sparsely, a breaking crest or a
// dragged finger lights up nearly every cell.
//
// Everything is evaluated in rest-space coordinates (the Gerstner "particle
// id"), so the plankton rides the orbital motion of the waves instead of
// sliding across them.
// ---------------------------------------------------------------------------

uniform vec3 uGlowColorA;          // cyan core  (#00f5ff, linear)
uniform vec3 uGlowColorB;          // teal       (#00ffc8, linear)
uniform vec3 uGlowDeep;            // bluer light from deeper water
uniform float uGlowIntensity;      // master multiplier
uniform float uGlowAmbient;        // baseline light inside patches
uniform float uGlowCrest;          // extra light at breaking crests
uniform float uGlowCrestThreshold; // fold amount (1 − Jacobian) where crests start to glow
uniform float uGlowRipple;         // extra light from the interaction heightfield
uniform float uNoiseScale;         // 1 / patch size (1/m)
uniform float uPatchCoverage;      // fraction of the sea inside dense patches
uniform float uBaseDensity;        // plankton outside patches, relative to inside
uniform float uGlowDrift;          // patch drift / morph speed
uniform float uGranularity;        // share of light that comes as discrete grains
uniform float uSparkleScale;       // grains per metre (coarsest octave)
uniform vec2 uCurrent;             // surface current, m/s (plankton drifts with it)

// --- Plankton patches ----------------------------------------------------------
// Returns (density 0..1, hue 0..1). Domain-warped fBm: a slow swirl field bends
// the noise into filaments and blobs like real blooms. Each octave is faded out
// once it is smaller than a few samples (`footprint`, metres per sample), so
// the sparse far grid / distant pixels see a stable average instead of noise.
vec2 planktonField(vec2 p, float t, float footprint) {
  vec2 q = (p - uCurrent * t) * uNoiseScale;
  float tt = t * uGlowDrift;

  vec2 warp = vec2(snoise(vec3(q * 0.45, tt)), snoise(vec3(q * 0.45 + 17.3, tt + 4.1)));
  q += warp * 1.4;

  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  float freq = 1.0;
  float featureSize = 1.0 / uNoiseScale;
  for (int i = 0; i < 4; i++) {
    float lod = 1.0 - smoothstep(0.12, 0.4, footprint * freq / featureSize);
    // Finer octaves churn a little faster: small blobs form and dissolve,
    // large patches persist.
    sum += amp * lod * snoise(vec3(q * freq, tt * (1.0 + float(i) * 0.7)));
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  float n = sum / norm * 0.5 + 0.5;

  // Soft-edged patches whose core is denser than their rim.
  float edge = 1.0 - uPatchCoverage;
  float density = smoothstep(edge - 0.08, edge + 0.22, n);
  density *= density;
  // Mostly cyan, drifting towards teal in places (0 = colour A, 1 = colour B).
  float hue = smoothstep(0.35, 0.95, snoise(vec3(q * 0.6 + 5.0, tt * 0.7)) * 0.5 + 0.5);
  return vec2(density, hue);
}

// --- Granular sparkle -----------------------------------------------------------
// One octave of plankton "cells": each lattice cell holds one small light at a
// random spot, with its own brightness (power law: a few bright sparks, many
// faint ones) and its own blink rhythm. Only a fraction `prob` of cells is lit.
//
// Anti-aliasing: each spark is a gaussian blurred by the pixel footprint with
// its peak scaled down so its total energy stays constant. Once the blur no
// longer fits inside the cell, the octave fades to its statistical mean, so
// distant water shows a smooth, correctly bright glow instead of crawling noise.
float grainOctave(vec2 p, float scale, float prob, float t, float footprint, int seed) {
  vec2 q = p * scale;
  vec2 cell = floor(q);
  vec2 f = q - cell;
  ivec2 ic = ivec2(cell);
  vec3 h = hash33(ivec3(ic, seed));
  vec3 h2 = hash33(ivec3(ic.x + 7919, ic.y - 104729, seed + 31));

  const float S = 0.1;                          // spark radius (gaussian sigma), in cells
  vec2 centre = 0.3 + 0.4 * h.xy;               // stays inside its cell: one lookup suffices
  vec2 d = f - centre;
  float px = footprint * scale * 0.45;          // pixel blur, in cells
  float s2 = S * S + px * px;
  float shape = exp(-dot(d, d) / (2.0 * s2)) * (S * S / s2);

  // Flash: a cubed rectified sine spends most of its time dark and peaks briefly.
  float blink = 0.5 + 0.5 * sin(t * (0.7 + 3.0 * h.z) + h2.x * 6.2831853);
  blink = blink * blink * blink;

  float brightness = 0.2 + 1.8 * h2.z * h2.z * h2.z;

  // Lit if this cell's threshold is below `prob` (soft edge avoids popping).
  float lit = clamp((prob - h2.y) * 6.0 + 0.5, 0.0, 1.0);

  // Mean over many cells: lit fraction × E[blink] (5/16) × E[brightness] (0.65)
  // × gaussian energy (2πS²).
  float mean = prob * 0.3125 * 0.65 * 6.2831853 * S * S;
  float resolved = 1.0 - smoothstep(0.17, 0.3, sqrt(s2));
  return mix(mean, shape * blink * brightness * lit, resolved);
}

// Three octaves, each ~2.3× finer: big slow sparks down to fine glitter. The
// fine octaves carry more weight so close water fizzes rather than polka-dots.
float sparkleField(vec2 p, float t, float footprint, float prob) {
  float s = uSparkleScale;
  float g = 0.8 * grainOctave(p, s, prob * 0.7, t, footprint, 1);
  g += 1.0 * grainOctave(p + vec2(3.17, -1.9), s * 2.31, prob, t * 1.3, footprint, 2);
  g += 1.0 * grainOctave(p - vec2(7.41, 2.6), s * 5.13, prob, t * 1.7, footprint, 3);
  return g;
}
