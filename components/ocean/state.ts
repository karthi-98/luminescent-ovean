import * as THREE from 'three';
import { createContext, useContext } from 'react';
import { config } from './config';
import { directionFromAngles, displayToScene, linearColor } from './colors';
import type { OceanAudio } from './OceanAudio';
import type { RippleSim } from './RippleSim';
import { WaveField } from './waves';

/** `config` with literal/readonly types widened, so the debug panel can edit a copy. */
type Widen<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends readonly (infer U)[]
        ? Widen<U>[]
        : T extends object
          ? { -readonly [K in keyof T]: Widen<T[K]> }
          : T;

export type OceanParams = Widen<typeof config>;

/** How many recent splashes the particle shader knows about. */
export const MAX_SPLASHES = 4;
/** Fish drawn by the water shader at once (must match shaders/water.frag). */
export const MAX_FISH = 4;

/** 0 = low, 1 = medium, 2 = high. */
export type QualityTier = 0 | 1 | 2;

type U<T> = { value: T };

/**
 * Everything the scene's components share: the live parameters, the wave
 * field, and one set of uniform objects. Materials spread these uniform
 * objects into their own `uniforms`, so a single write here (e.g. `uTime`)
 * reaches the sky, water and particles at once. Nothing in here is
 * reallocated per frame.
 */
export class OceanState {
  readonly params: OceanParams = structuredClone(config) as unknown as OceanParams;
  readonly waves = new WaveField();

  /** Simulation time in seconds (clamped per frame, so tab switches don't jump). */
  time = config.startTime;

  /** Horizontal boat position; the grid, ripple domain and particles follow it. */
  readonly boat = new THREE.Vector2(0, 0);

  /** Dev-only handles (camera, sims…) for inspecting the scene from the console. */
  readonly debug: Record<string, unknown> = {};

  readonly uniforms = {
    uTime: { value: 0 } as U<number>,
    uPixelRatio: { value: 1 } as U<number>,
    uExposure: { value: 1 } as U<number>,

    // Sky / moon (shaders/sky.glsl)
    uSkyZenith: { value: new THREE.Color() } as U<THREE.Color>,
    uSkyHorizon: { value: new THREE.Color() } as U<THREE.Color>,
    uSkyFalloff: { value: 4 } as U<number>,
    uMoonDir: { value: new THREE.Vector3(0, 0.15, -1).normalize() } as U<THREE.Vector3>,
    uMoonColor: { value: new THREE.Color() } as U<THREE.Color>,
    uMoonSize: { value: 0.02 } as U<number>,
    uMoonIntensity: { value: 1 } as U<number>,
    uMoonHalo: { value: 0.3 } as U<number>,
    uMilkyWay: { value: 0.5 } as U<number>,
    uStarSize: { value: 2 } as U<number>,
    uStarBrightness: { value: 1 } as U<number>,
    uTwinkle: { value: 0.5 } as U<number>,

    // Gerstner waves (shaders/waves.glsl)
    uWaveA: { value: this.waves.a } as U<Float32Array>,
    uWaveB: { value: this.waves.b } as U<Float32Array>,
    uWaveCount: { value: this.waves.count } as U<number>,
    /** World XZ of the camera-following grid / effect domains. */
    uOrigin: { value: new THREE.Vector2() } as U<THREE.Vector2>,

    // Water body (shaders/water.frag)
    uWaterColor: { value: new THREE.Color() } as U<THREE.Color>,
    uDeepColor: { value: new THREE.Color() } as U<THREE.Color>,
    uFogDensity: { value: 0.0015 } as U<number>,
    uReflection: { value: 1 } as U<number>,
    uMoonSpecular: { value: 0.5 } as U<number>,
    uMicroNormals: { value: 0.5 } as U<number>,

    // Bioluminescence (shaders/glow.glsl)
    uGlowColorA: { value: new THREE.Color() } as U<THREE.Color>,
    uGlowColorB: { value: new THREE.Color() } as U<THREE.Color>,
    uGlowDeep: { value: new THREE.Color() } as U<THREE.Color>,
    uGlowIntensity: { value: 1 } as U<number>,
    uGlowAmbient: { value: 0.3 } as U<number>,
    uGlowCrest: { value: 3 } as U<number>,
    uGlowCrestThreshold: { value: 0.3 } as U<number>,
    uGlowRipple: { value: 4 } as U<number>,
    uNoiseScale: { value: 0.045 } as U<number>,
    uPatchCoverage: { value: 0.55 } as U<number>,
    uBaseDensity: { value: 0.2 } as U<number>,
    uGlowDrift: { value: 0.035 } as U<number>,
    uGranularity: { value: 0.8 } as U<number>,
    uSparkleScale: { value: 3 } as U<number>,
    uCurrent: { value: new THREE.Vector2(0.05, -0.03) } as U<THREE.Vector2>,

    // Interaction heightfield (shaders/ripple.glsl), written by RippleSim
    uRippleTex: { value: null } as U<THREE.Texture | null>,
    uRippleDomain: { value: new THREE.Vector3(0, 0, 72) } as U<THREE.Vector3>,
    uRippleTexel: { value: 1 / 256 } as U<number>,
    uRippleDisplacement: { value: 0.2 } as U<number>,
    uRippleNormal: { value: 0.6 } as U<number>,
    /** Last MAX_SPLASHES splashes: (x, z, start time, strength) each. */
    uSplashes: { value: new Float32Array(MAX_SPLASHES * 4) } as U<Float32Array>,

    // Under-surface life (UnderwaterLife.tsx → water.frag)
    /** Per fish: (tail x, tail z, head x, head z). */
    uFish: { value: new Float32Array(MAX_FISH * 4) } as U<Float32Array>,
    uFishGlow: { value: new Float32Array(MAX_FISH) } as U<Float32Array>,
  };

  /** The interaction simulation, once the canvas has created it. */
  ripple: RippleSim | null = null;

  /** Ambient sound (null until the overlay creates it). */
  audio: OceanAudio | null = null;

  /** Boat motion, written by the camera rig every frame. */
  readonly motion = { heave: 0 };

  /** Current quality tier and smoothed frame rate (read by the debug panel). */
  readonly stats = { tier: 2 as QualityTier, fps: 0, dpr: 1 };

  private splashIndex = 0;
  private readonly interactionListeners = new Set<() => void>();
  private interacted = false;

  constructor() {
    this.applyParams();
    // Start time far in the past so empty splash slots are long finished.
    for (let i = 0; i < MAX_SPLASHES; i++) this.uniforms.uSplashes.value[i * 4 + 2] = -1e4;
  }

  /** Records a splash for the particles (ring buffer of MAX_SPLASHES). */
  addSplash(x: number, z: number, strength: number) {
    const v = this.uniforms.uSplashes.value;
    const o = this.splashIndex * 4;
    v[o] = x;
    v[o + 1] = z;
    v[o + 2] = this.time;
    v[o + 3] = strength;
    this.splashIndex = (this.splashIndex + 1) % MAX_SPLASHES;
  }

  /** The overlay hides its hint once the user has touched the water. */
  onFirstInteraction(listener: () => void): () => void {
    if (this.interacted) {
      listener();
      return () => {};
    }
    this.interactionListeners.add(listener);
    return () => this.interactionListeners.delete(listener);
  }

  notifyInteraction() {
    if (this.interacted) return;
    this.interacted = true;
    this.interactionListeners.forEach((l) => l());
    this.interactionListeners.clear();
  }

  /**
   * Recomputes every derived uniform from `params`. Cheap, but not meant to
   * run every frame: call it on start-up and when the debug panel changes.
   */
  applyParams() {
    const p = this.params;
    const u = this.uniforms;
    const exposure = p.post.exposure;

    u.uExposure.value = exposure;
    displayToScene(p.sky.zenith, exposure, u.uSkyZenith.value);
    displayToScene(p.sky.horizon, exposure, u.uSkyHorizon.value);
    u.uSkyFalloff.value = p.sky.gradientFalloff;
    u.uMilkyWay.value = p.sky.milkyWay;
    u.uStarSize.value = p.sky.starSize;
    u.uStarBrightness.value = p.sky.starBrightness;
    u.uTwinkle.value = p.sky.twinkle;

    directionFromAngles(p.moon.azimuth, p.moon.elevation, u.uMoonDir.value);
    linearColor(p.moon.color, u.uMoonColor.value);
    u.uMoonSize.value = THREE.MathUtils.degToRad(p.moon.size);
    u.uMoonIntensity.value = p.moon.intensity;
    u.uMoonHalo.value = p.moon.halo;

    displayToScene(p.water.baseColor, exposure, u.uWaterColor.value);
    displayToScene(p.water.deepColor, exposure, u.uDeepColor.value);
    u.uFogDensity.value = p.water.fogDensity;
    u.uReflection.value = p.water.reflection;
    u.uMoonSpecular.value = p.water.moonSpecular;
    u.uMicroNormals.value = p.water.microNormals;

    const g = p.glow;
    linearColor(g.colorA, u.uGlowColorA.value);
    linearColor(g.colorB, u.uGlowColorB.value);
    linearColor(g.deepColor, u.uGlowDeep.value);
    u.uGlowIntensity.value = g.intensity;
    u.uGlowAmbient.value = g.ambient;
    u.uGlowCrest.value = g.crest;
    u.uGlowCrestThreshold.value = g.crestThreshold;
    u.uGlowRipple.value = g.ripple;
    u.uNoiseScale.value = g.noiseScale;
    u.uPatchCoverage.value = g.patchCoverage;
    u.uBaseDensity.value = g.baseDensity;
    u.uGlowDrift.value = g.drift;
    u.uGranularity.value = g.granularity;
    u.uSparkleScale.value = g.sparkleScale;

    u.uRippleDisplacement.value = p.ripple.displacement;
    u.uRippleNormal.value = p.ripple.normalStrength;

    this.waves.update(p.waves.list, p.waves.count, p.waves.amplitude, p.waves.speed);
    u.uWaveCount.value = this.waves.count;
  }
}

export const OceanContext = createContext<OceanState | null>(null);

export function useOcean(): OceanState {
  const state = useContext(OceanContext);
  if (!state) throw new Error('useOcean() must be used inside <OceanContext.Provider>');
  return state;
}
