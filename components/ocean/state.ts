import * as THREE from 'three';
import { createContext, useContext } from 'react';
import { config } from './config';
import { directionFromAngles, displayToScene, linearColor } from './colors';
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
  time = 0;

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
  };

  constructor() {
    this.applyParams();
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
