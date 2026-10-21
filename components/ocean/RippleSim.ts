import * as THREE from 'three';
import { shaders } from './shaders';

/** Fixed simulation rate: behaviour is identical at 30, 60 or 144 fps. */
const STEP = 1 / 60;
/** Never run more than this many steps per frame (avoids a death spiral on slow frames). */
const MAX_STEPS = 4;
export const MAX_SOURCES = 4;

export interface RippleSettings {
  /** Side of the square domain, metres. */
  worldSize: number;
  /** Ripple propagation speed, m/s. */
  waveSpeed: number;
  /** Fraction of ripple height left after one second. */
  damping: number;
  /** Seconds for the glow energy to fall to ~37 %. */
  glowLifetime: number;
  /** Glow energy diffusion, m²/s. */
  diffusion: number;
  /** Glow energy created by moving water (passing ripples stir plankton too). */
  motionGlow: number;
}

/** The uniforms that *other* materials read the simulation through (see ocean_ripple). */
export interface RippleUniforms {
  uRippleTex: { value: THREE.Texture | null };
  uRippleDomain: { value: THREE.Vector3 };
  uRippleTexel: { value: number };
}

/**
 * Camera-following interaction heightfield on the GPU (ping-pong render
 * targets running shaders/ripple.frag). Besides the height of the ripples it
 * carries a separate "glow energy" channel; see ripple.frag for the maths.
 *
 * Inputs (strokes, splashes, fish) are queued in world coordinates and applied
 * on the next simulation step, so callers never touch GPU state directly.
 */
export class RippleSim {
  readonly supported: boolean;
  resolution = 0;

  private targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  private read = 0;
  private accumulator = 0;
  private readonly center = new THREE.Vector2(Number.NaN, Number.NaN);
  private worldSize = 72;

  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly material: THREE.ShaderMaterial;

  // Pending inputs, world space.
  private strokeQueued = false;
  private readonly stroke = new THREE.Vector4();
  private readonly strokeParams = new THREE.Vector3(); // (radius m, target depth m, target energy)
  private splashQueued = false;
  private readonly splash = new THREE.Vector4(); // (x, z, radius m, depth m)
  private splashEnergy = 0;
  private readonly sources = Array.from({ length: MAX_SOURCES }, () => new THREE.Vector4());
  private readonly sourceEnergy = new Float32Array(MAX_SOURCES);
  private sourceRadius = 0.8;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly output: RippleUniforms,
    resolution: number,
  ) {
    // Rendering into half-float textures needs one of these (near-universal on WebGL2).
    this.supported =
      renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');

    this.material = new THREE.ShaderMaterial({
      name: 'RippleStep',
      vertexShader: shaders.ripple.vertex,
      fragmentShader: shaders.ripple.fragment,
      uniforms: {
        uState: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uShift: { value: new THREE.Vector2() },
        uC2: { value: 0.1 },
        uDamping: { value: 0.99 },
        uEnergyDecay: { value: 0.99 },
        uDiffusion: { value: 0.05 },
        uMotionGlow: { value: 2 },
        uStroke: { value: new THREE.Vector4() },
        uStrokeParams: { value: new THREE.Vector3() },
        uSplash: { value: new THREE.Vector4() },
        uSplashEnergy: { value: 0 },
        uSources: { value: Array.from({ length: MAX_SOURCES }, () => new THREE.Vector4()) },
        uSourceEnergy: { value: new Float32Array(MAX_SOURCES) },
        uSourceRadius: { value: 0.01 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    this.setResolution(resolution);
  }

  /** Re-creates the render targets (state is reset). Cheap enough for quality changes. */
  setResolution(resolution: number) {
    if (!this.supported || resolution === this.resolution) return;
    this.disposeTargets();
    this.resolution = resolution;
    const make = () =>
      new THREE.WebGLRenderTarget(resolution, resolution, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS: THREE.ClampToEdgeWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
      });
    this.targets = [make(), make()];
    this.read = 0;
    this.center.set(Number.NaN, Number.NaN);
    this.output.uRippleTex.value = this.targets[0].texture;
    this.output.uRippleTexel.value = 1 / resolution;
  }

  /** Queue a brush stroke from (x0, z0) to (x1, z1). Several strokes in one frame merge. */
  addStroke(x0: number, z0: number, x1: number, z1: number, radius: number, depth: number, energy: number) {
    if (this.strokeQueued) {
      // Keep the earliest start, extend to the latest end, keep the strongest brush.
      this.stroke.z = x1;
      this.stroke.w = z1;
      this.strokeParams.set(
        Math.max(this.strokeParams.x, radius),
        Math.max(this.strokeParams.y, depth),
        Math.max(this.strokeParams.z, energy),
      );
    } else {
      this.stroke.set(x0, z0, x1, z1);
      this.strokeParams.set(radius, depth, energy);
      this.strokeQueued = true;
    }
  }

  addSplash(x: number, z: number, radius: number, depth: number, energy: number) {
    this.splash.set(x, z, radius, depth);
    this.splashEnergy = energy;
    this.splashQueued = true;
  }

  /** Energy-only capsule source (a glowing fish); energy 0 disables the slot. */
  setSource(index: number, x0: number, z0: number, x1: number, z1: number, energy: number, radius: number) {
    this.sources[index].set(x0, z0, x1, z1);
    this.sourceEnergy[index] = energy;
    this.sourceRadius = radius;
  }

  /** Advances the simulation by `dt` seconds with the domain centred near (cx, cz). */
  update(dt: number, cx: number, cz: number, settings: RippleSettings) {
    if (!this.targets) return;
    this.accumulator = Math.min(this.accumulator + dt, STEP * MAX_STEPS);
    const steps = Math.floor(this.accumulator / STEP);
    if (steps === 0) return;
    this.accumulator -= steps * STEP;

    const res = this.resolution;
    this.worldSize = settings.worldSize;
    const texelWorld = this.worldSize / res;
    const u = this.material.uniforms;

    // Recentre on whole texels so the field stays locked to the world.
    const nx = Math.round(cx / texelWorld) * texelWorld;
    const nz = Math.round(cz / texelWorld) * texelWorld;
    if (Number.isNaN(this.center.x)) this.center.set(nx, nz);
    const shiftX = (nx - this.center.x) / this.worldSize;
    const shiftZ = (nz - this.center.y) / this.worldSize;
    this.center.set(nx, nz);

    // Physical parameters → per-step, per-texel coefficients (resolution independent).
    const c = (settings.waveSpeed * STEP) / texelWorld;
    u.uC2.value = Math.min(c * c, 0.45);
    u.uDamping.value = Math.pow(settings.damping, STEP);
    u.uEnergyDecay.value = Math.exp(-STEP / Math.max(settings.glowLifetime, 0.05));
    u.uDiffusion.value = Math.min((settings.diffusion * STEP) / (texelWorld * texelWorld), 0.24);
    u.uMotionGlow.value = settings.motionGlow;
    u.uTexel.value.set(1 / res, 1 / res);

    // World → UV for the queued inputs.
    const toU = (x: number) => (x - nx) / this.worldSize + 0.5;
    const toV = (z: number) => (z - nz) / this.worldSize + 0.5;
    if (this.strokeQueued) {
      u.uStroke.value.set(toU(this.stroke.x), toV(this.stroke.y), toU(this.stroke.z), toV(this.stroke.w));
      u.uStrokeParams.value.set(this.strokeParams.x / this.worldSize, this.strokeParams.y, this.strokeParams.z);
    } else {
      u.uStrokeParams.value.set(0, 0, 0);
    }
    const sources = u.uSources.value as THREE.Vector4[];
    const sourceEnergy = u.uSourceEnergy.value as Float32Array;
    for (let i = 0; i < MAX_SOURCES; i++) {
      const s = this.sources[i];
      sources[i].set(toU(s.x), toV(s.y), toU(s.z), toV(s.w));
      sourceEnergy[i] = this.sourceEnergy[i];
    }
    u.uSourceRadius.value = this.sourceRadius / this.worldSize;

    const renderer = this.renderer;
    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    for (let i = 0; i < steps; i++) {
      // Recentring shift and the splash only apply once; strokes and fish
      // act on every step they span.
      u.uShift.value.set(i === 0 ? shiftX : 0, i === 0 ? shiftZ : 0);
      if (i === 0 && this.splashQueued) {
        u.uSplash.value.set(toU(this.splash.x), toV(this.splash.y), this.splash.z / this.worldSize, this.splash.w);
        u.uSplashEnergy.value = this.splashEnergy;
      } else {
        u.uSplash.value.set(0, 0, 0, 0);
        u.uSplashEnergy.value = 0;
      }
      const source = this.targets[this.read];
      const dest = this.targets[1 - this.read];
      u.uState.value = source.texture;
      renderer.setRenderTarget(dest);
      renderer.render(this.scene, this.camera);
      this.read = 1 - this.read;
    }

    renderer.setRenderTarget(previousTarget);
    renderer.autoClear = previousAutoClear;

    this.strokeQueued = false;
    this.splashQueued = false;

    this.output.uRippleTex.value = this.targets[this.read].texture;
    this.output.uRippleDomain.value.set(nx, nz, this.worldSize);
  }

  private disposeTargets() {
    this.targets?.forEach((t) => t.dispose());
    this.targets = null;
  }

  /** Frees GPU memory. A later setResolution() brings the simulation back (React StrictMode remounts). */
  dispose() {
    this.disposeTargets();
    this.resolution = 0;
    this.quad.geometry.dispose();
    this.material.dispose();
    this.output.uRippleTex.value = null;
  }
}
