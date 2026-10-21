import * as THREE from 'three';

/**
 * The colours in `config.ts` for the sky and the water body are the colours
 * you should *see on screen* (e.g. the spec's #01030a zenith). The frame goes
 * through ACES Filmic tone mapping, which crushes very dark values by 3–5x,
 * so feeding those hex values straight into the shaders would render a
 * near-black sky. `displayToScene` inverts three.js' ACES Filmic operator
 * (input matrix → RRT/ODT curve → output matrix) so the tone-mapped result
 * lands back on the authored colour.
 *
 * Emissive colours (the plankton glow) are *not* inverted: they are HDR
 * light sources whose brightness is set by an intensity multiplier.
 */

// Matrices from three.js' ACESFilmicToneMapping (column-major, as in GLSL).
const ACES_INPUT = new THREE.Matrix3().set(
  0.59719, 0.35458, 0.04823,
  0.076, 0.90834, 0.01566,
  0.0284, 0.13383, 0.83777,
);
const ACES_OUTPUT = new THREE.Matrix3().set(
  1.60475, -0.53108, -0.07367,
  -0.10208, 1.10813, -0.00605,
  -0.00327, -0.07276, 1.07602,
);
const ACES_INPUT_INV = ACES_INPUT.clone().invert();
const ACES_OUTPUT_INV = ACES_OUTPUT.clone().invert();

/** RRT + ODT fit used by three.js. Monotonic for v >= 0. */
function rrtOdtFit(v: number): number {
  const a = v * (v + 0.0245786) - 0.000090537;
  const b = v * (0.983729 * v + 0.432951) + 0.238081;
  return a / b;
}

/** Inverts `rrtOdtFit` by bisection (it saturates at ~1.02, so clamp the target). */
function rrtOdtFitInverse(target: number): number {
  const t = Math.min(Math.max(target, 0), 0.999);
  let lo = 0;
  let hi = 64;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) * 0.5;
    if (rrtOdtFit(mid) < t) lo = mid;
    else hi = mid;
  }
  return (lo + hi) * 0.5;
}

const tmp = new THREE.Vector3();

/**
 * Converts a display-referred sRGB colour into the linear scene radiance that
 * reproduces it after ACES Filmic tone mapping at the given exposure.
 */
export function displayToScene(hex: string, exposure = 1, target = new THREE.Color()): THREE.Color {
  target.set(hex); // sRGB hex → linear working space
  tmp.set(target.r, target.g, target.b).applyMatrix3(ACES_OUTPUT_INV);
  tmp.set(rrtOdtFitInverse(tmp.x), rrtOdtFitInverse(tmp.y), rrtOdtFitInverse(tmp.z));
  tmp.applyMatrix3(ACES_INPUT_INV).multiplyScalar(0.6 / Math.max(exposure, 1e-4));
  return target.setRGB(Math.max(tmp.x, 0), Math.max(tmp.y, 0), Math.max(tmp.z, 0));
}

/** Plain sRGB hex → linear colour, for HDR emissive colours. */
export function linearColor(hex: string, target = new THREE.Color()): THREE.Color {
  return target.set(hex);
}

/** Unit direction from azimuth (deg, clockwise from -Z) and elevation (deg). */
export function directionFromAngles(azimuthDeg: number, elevationDeg: number, target = new THREE.Vector3()) {
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const el = THREE.MathUtils.degToRad(elevationDeg);
  return target.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}
