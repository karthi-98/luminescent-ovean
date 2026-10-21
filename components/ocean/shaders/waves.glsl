// ---------------------------------------------------------------------------
// ocean_waves — sum of Gerstner (trochoidal) waves. Mirrored on the CPU in
// waves.ts, so the boat and the pointer ray-cast see the same surface.
//
// For a rest position p on the flat sea, each wave moves the water particle
// on a circle:   f = k (D·p − c t) + φ
//                P = p + Σ ( D a cos f ,  a sin f )
// with k = 2π/λ, c = √(g/k) (deep-water phase speed) and amplitude a = Q/k,
// where Q is the steepness. Σ Q ≤ 1 keeps the crests from looping over.
//
// The derivatives are analytic, so normals need no finite differences:
//   ∂P/∂x = (1 − Dx² Q sin f,  Dx Q cos f,  −Dx Dz Q sin f)   (tangent)
//   ∂P/∂z = (−Dx Dz Q sin f,  Dz Q cos f,  1 − Dz² Q sin f)   (binormal)
//   N = normalize(binormal × tangent)
// and the Jacobian of the horizontal map, J = Tx·Bz − Tz·Bx, drops towards 0
// where the surface is being squeezed into a sharp crest: that is where
// waves break, so it drives the whitecap / crest glow.
// ---------------------------------------------------------------------------
#define MAX_WAVES 8

uniform vec4 uWaveA[MAX_WAVES];  // (dirX, dirZ, k, c)
uniform vec4 uWaveB[MAX_WAVES];  // (steepness Q, amplitude a, phase φ, wavelength λ)
uniform int uWaveCount;

// Level of detail: a wave whose wavelength is only a few samples long
// (`footprint` = metres per grid cell or per pixel) would alias into noise,
// so it is faded out smoothly before that happens.
float waveLod(float wavelength, float footprint) {
  return 1.0 - smoothstep(wavelength * 0.1, wavelength * 0.25, footprint);
}

// Displacement only — cheap path for the vertex shader.
vec3 gerstnerDisplacement(vec2 p, float t, float footprint) {
  vec3 d = vec3(0.0);
  for (int i = 0; i < MAX_WAVES; i++) {
    if (i >= uWaveCount) break;
    vec4 A = uWaveA[i];
    vec4 B = uWaveB[i];
    float lod = waveLod(B.w, footprint);
    if (lod <= 0.0) continue;
    float f = A.z * (dot(A.xy, p) - A.w * t) + B.z;
    float amp = B.y * lod;
    d.xz += A.xy * (amp * cos(f));
    d.y += amp * sin(f);
  }
  return d;
}

struct WaveSample {
  vec3 displacement;
  vec3 normal;
  float jacobian;   // 1 = undisturbed, → 0 at sharp / breaking crests
  float lostVar;    // slope variance of the waves LOD removed (for specular AA)
};

// Full evaluation with the analytic tangent frame — used per pixel.
WaveSample gerstnerSample(vec2 p, float t, float footprint) {
  vec3 d = vec3(0.0);
  vec3 T = vec3(1.0, 0.0, 0.0);
  vec3 Bn = vec3(0.0, 0.0, 1.0);
  float lostVar = 0.0;
  for (int i = 0; i < MAX_WAVES; i++) {
    if (i >= uWaveCount) break;
    vec4 A = uWaveA[i];
    vec4 B = uWaveB[i];
    float lod = waveLod(B.w, footprint);
    // A sinusoid with slope amplitude Q has slope variance Q²/2. Whatever is
    // faded out here is handed to the specular lobe as extra roughness, so
    // the moon path keeps its brightness and width at every distance.
    lostVar += (1.0 - lod) * B.x * B.x * 0.5;
    if (lod <= 0.0) continue;
    vec2 D = A.xy;
    float f = A.z * (dot(D, p) - A.w * t) + B.z;
    float sf = sin(f);
    float cf = cos(f);
    float q = B.x * lod;
    float amp = B.y * lod;
    d.xz += D * (amp * cf);
    d.y += amp * sf;
    T += vec3(-D.x * D.x * q * sf, D.x * q * cf, -D.x * D.y * q * sf);
    Bn += vec3(-D.x * D.y * q * sf, D.y * q * cf, -D.y * D.y * q * sf);
  }
  WaveSample w;
  w.displacement = d;
  w.normal = normalize(cross(Bn, T));
  w.jacobian = T.x * Bn.z - T.z * Bn.x;
  w.lostVar = lostVar;
  return w;
}
