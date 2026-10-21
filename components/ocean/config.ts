/**
 * Every tunable number of the scene lives here, so the look can be adjusted
 * in one place. The leva debug panel (dev only) edits a live copy of these
 * values; nothing here is mutated at runtime.
 *
 * Units: distances are metres, angles are degrees, times are seconds.
 * Colours are sRGB hex strings (three.js converts them to linear for shaders).
 */

export interface WaveParams {
  /** Travel direction, degrees clockwise from -Z (the initial view direction). */
  direction: number;
  /** Gerstner steepness (0..1). The sum over all waves should stay <= ~1. */
  steepness: number;
  /** Crest-to-crest distance in metres. */
  wavelength: number;
  /** Multiplier on the physical deep-water phase speed sqrt(g / k). */
  speed: number;
}

export const MAX_WAVES = 8;

export const config = {
  sky: {
    zenith: '#01030a',
    horizon: '#0a1a2e',
    /** How quickly the gradient darkens above the horizon (bigger = thinner band). */
    gradientFalloff: 4.5,
    starCount: 3000,
    starBrightness: 1.0,
    starSize: 2.2,
    twinkle: 0.55,
    milkyWay: 0.55,
  },

  moon: {
    /** Degrees clockwise from -Z. */
    azimuth: -28,
    /** Degrees above the horizon: low, so it lays a long path across the water. */
    elevation: 9,
    /** Angular radius in degrees (the real moon is ~0.26; cinema moons are bigger). */
    size: 1.15,
    color: '#dfe6f2',
    /** Disc brightness. Kept below the plankton glow on purpose. */
    intensity: 0.85,
    halo: 0.32,
  },

  camera: {
    fov: 50,
    /** Eye height above the mean water level. */
    height: 3.6,
    near: 0.1,
    far: 9000,
    /** 0 = rigid tripod, 1 = follows the boat fully. */
    bobStrength: 1.0,
    /** Boat roll/pitch as a fraction of the local surface tilt. */
    rollStrength: 0.4,
    /** Slow drift of the boat across the sea, metres per second. */
    drift: 0.12,
    driftDirection: 40,
    /** Look limits relative to the horizon, degrees. */
    maxLookUp: 55,
    maxLookDown: 50,
    /** Initial yaw (degrees clockwise from -Z) and pitch (negative = down). */
    initialYaw: 0,
    initialPitch: -7,
  },

  waves: {
    /** Global multipliers applied on top of the per-wave values. */
    amplitude: 1.0,
    speed: 0.62,
    count: 8,
    /** 2 long swells (40–80 m) + 6 chop waves (2–8 m). */
    list: [
      { direction: 12, steepness: 0.07, wavelength: 72, speed: 1.0 },
      { direction: -24, steepness: 0.06, wavelength: 46, speed: 1.0 },
      { direction: 38, steepness: 0.13, wavelength: 8.0, speed: 1.0 },
      { direction: -52, steepness: 0.13, wavelength: 6.1, speed: 1.0 },
      { direction: 74, steepness: 0.12, wavelength: 4.7, speed: 1.0 },
      { direction: -8, steepness: 0.12, wavelength: 3.6, speed: 1.0 },
      { direction: 118, steepness: 0.1, wavelength: 2.7, speed: 1.0 },
      { direction: -96, steepness: 0.1, wavelength: 2.1, speed: 1.0 },
    ] satisfies WaveParams[],
  },

  water: {
    /** Deep near-black navy of the water body. */
    baseColor: '#020814',
    /** Water seen through steep wave faces gets a hint of this deep blue. */
    deepColor: '#03142b',
    /** Exponential-squared distance fog, per metre. */
    fogDensity: 0.0016,
    /** Strength of the sky reflection (on top of physical Fresnel). */
    reflection: 1.0,
    /** Moonlight on the water: overall strength of the glitter path. */
    moonSpecular: 0.55,
    /** Small capillary ripples that break the moon path into glitter. */
    microNormals: 0.55,
    /** Radius of the camera-following grid; must stay inside camera.far. */
    gridRadius: 6000,
  },

  glow: {
    /** Bioluminescence colours: cyan core → teal (spec: #00f5ff → #00ffc8). */
    colorA: '#00f5ff',
    colorB: '#00ffc8',
    /** Light scattered back up from deeper plankton is a touch bluer. */
    deepColor: '#0077ff',
    /** Master multiplier on every emissive term. */
    intensity: 1.0,
    /** Soft, always-on glow inside plankton patches. */
    ambient: 0.32,
    /** Glow at breaking crests / whitecaps. */
    crest: 3.2,
    /** Jacobian fold amount where crests start to light up (0..1). */
    crestThreshold: 0.3,
    /** Glow from the interaction heightfield (mouse / touch / fish). */
    ripple: 4.0,
    /** World-space scale of the drifting plankton patches (1 / metres). */
    noiseScale: 0.045,
    /** Fraction of the sea surface covered by dense patches (0..1). */
    patchCoverage: 0.55,
    /** Glow outside of patches relative to inside (plankton is everywhere, just thinner). */
    baseDensity: 0.18,
    /** Speed of the patch drift / morphing. */
    drift: 0.035,
    /** How granular the glow is: 0 = smooth, 1 = all sparkle. */
    granularity: 0.82,
    /** Grains per metre of the finest sparkle octave. */
    sparkleScale: 11.0,
  },

  ripple: {
    /** Side of the square simulation domain that follows the camera, metres. */
    worldSize: 72,
    /** Texture resolution per quality tier (low, medium, high). */
    resolution: [128, 256, 512] as const,
    /** Wave propagation (c² in texels² per step, stable below 0.5). */
    waveSpeed: 0.42,
    /** Per-step damping of the height field (closer to 1 = longer ripples). */
    damping: 0.988,
    /** Per-second decay of the glow energy left behind by a disturbance. */
    decay: 0.55,
    /** How much the glow energy spreads out. */
    diffusion: 0.18,
    /** Vertical displacement of the water from the ripple heightfield. */
    displacement: 0.22,
    /** Brush radius of a pointer stroke, metres. */
    brushRadius: 0.9,
    strokeStrength: 1.0,
    splashRadius: 2.4,
    splashStrength: 4.0,
  },

  plankton: {
    enabled: true,
    /** Particle count per quality tier (low, medium, high). */
    count: [9000, 22000, 42000] as const,
    /** Side of the square domain the particles tile around the camera. */
    worldSize: 64,
    /** Particles live from the surface down to this depth. */
    depth: 1.4,
    size: 1.0,
    brightness: 1.0,
    /** Rate of spontaneous random flashes. */
    sparkle: 0.35,
  },

  life: {
    enabled: true,
    /** Average seconds between fish darting past. */
    interval: 5.0,
    brightness: 1.0,
  },

  post: {
    bloomThreshold: 0.6,
    bloomSmoothing: 0.25,
    bloomIntensity: 1.35,
    bloomRadius: 0.72,
    vignette: 0.55,
    grain: 0.055,
    chromaticAberration: 0.0006,
    exposure: 1.0,
  },
} as const;

export type OceanConfig = typeof config;
