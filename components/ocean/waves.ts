import { MAX_WAVES, type WaveParams } from './config';

/**
 * CPU mirror of the Gerstner wave sum in `shaders/waves.glsl`.
 *
 * The same packed arrays are uploaded as shader uniforms, so the boat (camera
 * bobbing) and the pointer ray-cast see exactly the surface that is rendered.
 *
 * For a rest position p (x, z) at time t, wave i has phase
 *   f = k (D·p) − ω t + φ        (k = 2π/λ, ω = k·c, c = phase speed)
 * and moves the water particle to
 *   P.x = p.x + Σ D.x a cos f,   P.y = Σ a sin f,   P.z = p.z + Σ D.z a cos f
 * with amplitude a = Q / k (Q = steepness).
 *
 * Precision: `ω t` grows without bound, and float32 can no longer represent it
 * finely enough after a few hours. So the GPU never sees t: every frame,
 * `setTime` computes (φ − ω t) mod 2π in float64 and uploads that as the
 * phase. The shader adds k (D·p) and, for look-ups at another moment, −ω·δt.
 *
 * Uniform packing per wave i (two vec4):
 *   A[i] = (dirX, dirZ, k, ω)
 *   B[i] = (steepness, amplitude, phase at the current time (wrapped), wavelength)
 */

const G = 9.81;
const TAU = Math.PI * 2;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

/** Same LOD fade as waveLod() in waves.glsl. */
function waveLod(wavelength: number, footprint: number): number {
  return 1 - smoothstep(wavelength * 0.1, wavelength * 0.25, footprint);
}

export interface SurfaceSample {
  /** Height of the surface above mean sea level. */
  height: number;
  /** Unit normal. */
  nx: number;
  ny: number;
  nz: number;
}

export interface Displacement {
  x: number;
  y: number;
  z: number;
}

/** Optional filtering of the wave sum when sampling it on the CPU. */
export interface SampleFilter {
  /**
   * A floating body of this length (m): waves much shorter than the hull
   * average out under it, so each wave is weighted by smoothstep(hull, 3·hull, λ).
   */
  hull?: number;
  /** Apply the GPU's level-of-detail fade for this grid spacing (m), as water.vert does. */
  footprint?: number;
}

export class WaveField {
  /** GPU uniforms (see packing above). */
  readonly a = new Float32Array(MAX_WAVES * 4);
  readonly b = new Float32Array(MAX_WAVES * 4);
  count = MAX_WAVES;

  // Float64 copies for the CPU evaluation (no float32 phase error).
  private readonly dirX = new Float64Array(MAX_WAVES);
  private readonly dirZ = new Float64Array(MAX_WAVES);
  private readonly k = new Float64Array(MAX_WAVES);
  private readonly omega = new Float64Array(MAX_WAVES);
  private readonly phase = new Float64Array(MAX_WAVES);
  private readonly steep = new Float64Array(MAX_WAVES);
  private readonly amp = new Float64Array(MAX_WAVES);
  private readonly wavelength = new Float64Array(MAX_WAVES);
  private initialised = false;

  private readonly scratch: Displacement = { x: 0, y: 0, z: 0 };

  /**
   * Repacks the wave parameters. Call whenever they change (never per frame).
   * `time` keeps the motion continuous: if a wave's frequency changes, its
   * phase is shifted so the surface does not jump at that moment.
   */
  update(list: readonly WaveParams[], count: number, amplitude: number, speed: number, time = 0) {
    this.count = Math.max(0, Math.min(count, list.length, MAX_WAVES));
    for (let i = 0; i < MAX_WAVES; i++) {
      const w = list[i];
      if (!w || i >= this.count) {
        this.steep[i] = 0;
        this.amp[i] = 0;
        continue;
      }
      const angle = (w.direction * Math.PI) / 180;
      const k = TAU / Math.max(w.wavelength, 0.01);
      const omega = Math.sqrt(G / k) * w.speed * speed * k;
      // Seed phase: a fixed pseudo-random offset per wave keeps the crests
      // from all lining up at the origin.
      const seed = (i * 2.399963) % TAU;
      this.phase[i] = this.initialised ? this.phase[i] + (omega - this.omega[i]) * time : seed;
      this.dirX[i] = Math.sin(angle);
      this.dirZ[i] = -Math.cos(angle);
      this.k[i] = k;
      this.omega[i] = omega;
      this.steep[i] = w.steepness * amplitude;
      this.amp[i] = this.steep[i] / k;
      this.wavelength[i] = w.wavelength;
    }
    this.initialised = true;
    this.a.fill(0);
    this.b.fill(0);
    for (let i = 0; i < this.count; i++) {
      this.a[i * 4] = this.dirX[i];
      this.a[i * 4 + 1] = this.dirZ[i];
      this.a[i * 4 + 2] = this.k[i];
      this.a[i * 4 + 3] = this.omega[i];
      this.b[i * 4] = this.steep[i];
      this.b[i * 4 + 1] = this.amp[i];
      this.b[i * 4 + 3] = this.wavelength[i];
    }
    this.setTime(time);
  }

  /** Writes the wrapped per-wave phases for time t into the GPU arrays. Call once per frame. */
  setTime(t: number) {
    for (let i = 0; i < this.count; i++) {
      let p = (this.phase[i] - this.omega[i] * t) % TAU;
      if (p < 0) p += TAU;
      this.b[i * 4 + 2] = p;
    }
  }

  /** Sum of all amplitudes: an upper bound for |height|. */
  get maxHeight(): number {
    let h = 0;
    for (let i = 0; i < this.count; i++) h += this.amp[i];
    return h;
  }

  private weight(i: number, filter?: SampleFilter): number {
    if (!filter) return 1;
    let w = 1;
    if (filter.hull && filter.hull > 0) w *= smoothstep(filter.hull, 3 * filter.hull, this.wavelength[i]);
    if (filter.footprint !== undefined) w *= waveLod(this.wavelength[i], filter.footprint);
    return w;
  }

  /** Displacement of the rest position (x, z). */
  displacement(x: number, z: number, t: number, out: Displacement, filter?: SampleFilter): Displacement {
    let dx = 0;
    let dy = 0;
    let dz = 0;
    for (let i = 0; i < this.count; i++) {
      const amp = this.amp[i] * this.weight(i, filter);
      if (amp === 0) continue;
      const f = this.k[i] * (this.dirX[i] * x + this.dirZ[i] * z) - this.omega[i] * t + this.phase[i];
      const cf = Math.cos(f);
      dx += this.dirX[i] * amp * cf;
      dz += this.dirZ[i] * amp * cf;
      dy += amp * Math.sin(f);
    }
    out.x = dx;
    out.y = dy;
    out.z = dz;
    return out;
  }

  /**
   * Surface height and normal at a *world* position (x, z). Gerstner waves move
   * points horizontally, so the rest position whose displaced point lands on
   * (x, z) is found with a few fixed-point iterations first.
   */
  sample(x: number, z: number, t: number, out: SurfaceSample, filter?: SampleFilter): SurfaceSample {
    const d = this.scratch;
    let px = x;
    let pz = z;
    for (let iter = 0; iter < 4; iter++) {
      this.displacement(px, pz, t, d, filter);
      px = x - d.x;
      pz = z - d.z;
    }

    // Analytic tangent (∂P/∂x) and binormal (∂P/∂z), as in the shaders.
    let tx = 1;
    let ty = 0;
    let tz = 0;
    let bx = 0;
    let by = 0;
    let bz = 1;
    let height = 0;
    for (let i = 0; i < this.count; i++) {
      const w = this.weight(i, filter);
      if (w === 0) continue;
      const dX = this.dirX[i];
      const dZ = this.dirZ[i];
      const f = this.k[i] * (dX * px + dZ * pz) - this.omega[i] * t + this.phase[i];
      const s = this.steep[i] * w;
      const sf = Math.sin(f);
      const cf = Math.cos(f);
      height += this.amp[i] * w * sf;
      tx -= dX * dX * s * sf;
      ty += dX * s * cf;
      tz -= dX * dZ * s * sf;
      bx -= dX * dZ * s * sf;
      by += dZ * s * cf;
      bz -= dZ * dZ * s * sf;
    }
    // n = normalize(cross(binormal, tangent))
    const nx = by * tz - bz * ty;
    const ny = bz * tx - bx * tz;
    const nz = bx * ty - by * tx;
    const len = Math.hypot(nx, ny, nz) || 1;
    out.height = height;
    out.nx = nx / len;
    out.ny = ny / len;
    out.nz = nz / len;
    return out;
  }
}

/**
 * Capillary "micro" waves: evaluated only per pixel in water.frag (they never
 * move geometry) to break the moon reflection into glitter. Defined here so
 * their phases can be wrapped on the CPU like the Gerstner ones.
 * (dirX, dirZ, wavelength m, slope amplitude)
 */
export const MICRO_WAVES: readonly [number, number, number, number][] = [
  [-0.139, -0.99, 1.31, 0.1],
  [0.574, -0.819, 0.93, 0.09],
  [-0.766, -0.643, 0.71, 0.09],
  [0.985, -0.174, 0.53, 0.08],
  [-0.985, 0.174, 0.39, 0.08],
  [0.5, 0.866, 0.29, 0.07],
];

/** Writes (−ω t + seed) mod 2π for each micro wave into `out`. */
export function microPhases(t: number, out: Float32Array) {
  for (let i = 0; i < MICRO_WAVES.length; i++) {
    const k = TAU / MICRO_WAVES[i][2];
    const omega = Math.sqrt(G * k) * 0.6;
    let p = (i * 1.7 - omega * t) % TAU;
    if (p < 0) p += TAU;
    out[i] = p;
  }
}
