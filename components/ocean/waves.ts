import { MAX_WAVES, type WaveParams } from './config';

/**
 * CPU mirror of the Gerstner wave sum in `shaders/waves.glsl`.
 *
 * The same packed arrays are uploaded as shader uniforms, so the boat (camera
 * bobbing) and the pointer ray-cast see exactly the surface that is rendered.
 *
 * Packing per wave i (two vec4 uniforms):
 *   A[i] = (dirX, dirZ, k, c)         k = 2π / wavelength, c = phase speed
 *   B[i] = (steepness, amplitude, phase, wavelength)
 *
 * Surface point for a rest position p (x, z) at time t:
 *   f   = k (D·p − c t) + phase
 *   P.x = p.x + Σ D.x a cos f
 *   P.y =       Σ     a sin f
 *   P.z = p.z + Σ D.z a cos f        with a = steepness / k
 */

const G = 9.81;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
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

export class WaveField {
  readonly a = new Float32Array(MAX_WAVES * 4);
  readonly b = new Float32Array(MAX_WAVES * 4);
  count = MAX_WAVES;

  private readonly scratch: Displacement = { x: 0, y: 0, z: 0 };

  /** Repacks the uniform arrays. Call whenever wave parameters change (never per frame). */
  update(list: readonly WaveParams[], count: number, amplitude: number, speed: number) {
    this.count = Math.max(0, Math.min(count, list.length, MAX_WAVES));
    this.a.fill(0);
    this.b.fill(0);
    for (let i = 0; i < this.count; i++) {
      const w = list[i];
      const angle = (w.direction * Math.PI) / 180;
      const k = (2 * Math.PI) / Math.max(w.wavelength, 0.01);
      const c = Math.sqrt(G / k) * w.speed * speed;
      const steepness = w.steepness * amplitude;
      this.a[i * 4 + 0] = Math.sin(angle);
      this.a[i * 4 + 1] = -Math.cos(angle);
      this.a[i * 4 + 2] = k;
      this.a[i * 4 + 3] = c;
      this.b[i * 4 + 0] = steepness;
      this.b[i * 4 + 1] = steepness / k;
      // A fixed pseudo-random phase per wave keeps the crests from all lining up at the origin.
      this.b[i * 4 + 2] = (i * 2.399963) % (2 * Math.PI);
      this.b[i * 4 + 3] = w.wavelength;
    }
  }

  /** Sum of all amplitudes: an upper bound for |height|. */
  get maxHeight(): number {
    let h = 0;
    for (let i = 0; i < this.count; i++) h += this.b[i * 4 + 1];
    return h;
  }

  /** Displacement of the rest position (x, z). */
  displacement(x: number, z: number, t: number, out: Displacement): Displacement {
    let dx = 0;
    let dy = 0;
    let dz = 0;
    const { a, b } = this;
    for (let i = 0; i < this.count; i++) {
      const o = i * 4;
      const f = a[o + 2] * (a[o] * x + a[o + 1] * z - a[o + 3] * t) + b[o + 2];
      const amp = b[o + 1];
      const cf = Math.cos(f);
      dx += a[o] * amp * cf;
      dz += a[o + 1] * amp * cf;
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
   *
   * `hull` (metres) models a floating body of that length: waves much shorter
   * than the hull average out under it and barely move it, so each wave's
   * contribution is weighted by smoothstep(hull, 3·hull, wavelength).
   * hull = 0 returns the exact surface.
   */
  sample(x: number, z: number, t: number, out: SurfaceSample, hull = 0): SurfaceSample {
    const d = this.scratch;
    let px = x;
    let pz = z;
    for (let iter = 0; iter < 4; iter++) {
      this.displacement(px, pz, t, d);
      px = x - d.x;
      pz = z - d.z;
    }

    // Analytic tangent (∂P/∂x) and binormal (∂P/∂z), as in the vertex shader.
    let tx = 1;
    let ty = 0;
    let tz = 0;
    let bx = 0;
    let by = 0;
    let bz = 1;
    let height = 0;
    const { a, b } = this;
    for (let i = 0; i < this.count; i++) {
      const o = i * 4;
      const dX = a[o];
      const dZ = a[o + 1];
      const f = a[o + 2] * (dX * px + dZ * pz - a[o + 3] * t) + b[o + 2];
      const response = hull > 0 ? smoothstep(hull, 3 * hull, b[o + 3]) : 1;
      const s = b[o] * response;
      const sf = Math.sin(f);
      const cf = Math.cos(f);
      height += b[o + 1] * response * sf;
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
