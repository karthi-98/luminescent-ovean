// ---------------------------------------------------------------------------
// Water surface — fragment stage.
//
//   colour = mix(body, sky reflection, Fresnel) + moon glitter       (base)
//          + bioluminescence                                          (stage 4)
//   then distance fog towards the sky's own horizon colour.
// ---------------------------------------------------------------------------
#include <ocean_common>
#include <ocean_noise>
#include <ocean_sky>
#include <ocean_waves>

#define PI 3.14159265

uniform vec3 uWaterColor;     // near-black navy body (scene-linear)
uniform vec3 uDeepColor;      // faint blue seen through thin crests
uniform float uFogDensity;
uniform float uReflection;
uniform float uMoonSpecular;
uniform float uMicroNormals;

varying vec3 vWorldPos;
varying vec2 vRestXZ;

// --- Capillary "micro" waves ------------------------------------------------
// Six short sines (0.3–1.3 m) evaluated only per pixel. They never move the
// geometry, but they break the moon reflection into a glittering path.
// (dirX, dirZ, wavelength, slope amplitude)
const vec4 MICRO[6] = vec4[6](
  vec4(-0.139, -0.990, 1.31, 0.10),
  vec4( 0.574, -0.819, 0.93, 0.09),
  vec4(-0.766, -0.643, 0.71, 0.09),
  vec4( 0.985, -0.174, 0.53, 0.08),
  vec4(-0.985,  0.174, 0.39, 0.08),
  vec4( 0.500,  0.866, 0.29, 0.07)
);

// Returns the height gradient of the micro waves (xy) and the slope variance
// lost to LOD (z).
vec3 microWaves(vec2 p, float t, float footprint, float strength) {
  vec2 grad = vec2(0.0);
  float lostVar = 0.0;
  for (int i = 0; i < 6; i++) {
    vec4 m = MICRO[i];
    float k = 2.0 * PI / m.z;
    float omega = sqrt(9.81 * k) * 0.6;
    float lod = waveLod(m.z, footprint);
    float slope = m.w * strength;
    lostVar += (1.0 - lod) * slope * slope * 0.5;
    float f = k * dot(m.xy, p) - omega * t + float(i) * 1.7;
    grad += m.xy * (slope * lod * cos(f));
  }
  return vec3(grad, lostVar);
}

void main() {
  vec3 toEye = cameraPosition - vWorldPos;
  float dist = length(toEye);
  vec3 V = toEye / dist;

  // Metres of sea surface covered by this pixel: drives every LOD decision.
  float footprint = max(length(fwidth(vRestXZ)), 1e-4);

  // --- Surface normal ---------------------------------------------------------
  WaveSample w = gerstnerSample(vRestXZ, uTime, footprint);

  // Gusts: patches of wind roughen the surface ("cat's paws"), so the moon
  // path is broken up irregularly instead of uniformly.
  float gust = smoothstep(-0.6, 0.8, snoise(vec3(vRestXZ * 0.035, uTime * 0.025)));
  vec3 micro = microWaves(vRestXZ, uTime, footprint, uMicroNormals * (0.35 + 0.9 * gust));
  vec3 N = normalize(vec3(w.normal.x - micro.x, w.normal.y, w.normal.z - micro.y));

  float NdotV = max(dot(N, V), 1e-3);

  // --- Fresnel (Schlick, water F0 = 0.02) -------------------------------------
  float fresnel = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);

  // --- Sky reflection ---------------------------------------------------------
  vec3 R = reflect(-V, N);
  vec3 refl = skyColor(normalize(vec3(R.x, abs(R.y), R.z)));
  // A reflected ray that points down would see the next wave, not the sky.
  refl *= mix(0.5, 1.0, smoothstep(-0.15, 0.05, R.y));

  // --- Water body -----------------------------------------------------------
  // Almost black; thin, raised crests let a little deep blue through.
  float crestHeight = clamp(w.displacement.y * 0.9 + 0.5, 0.0, 1.0);
  vec3 body = mix(uWaterColor, uDeepColor, crestHeight * crestHeight * 0.7);

  vec3 col = mix(body, refl * uReflection, fresnel);

  // --- Moon glitter path ------------------------------------------------------
  // Beckmann microfacet lobe. Its slope variance = a little base roughness
  // + the moon's angular size + every bit of wave slope that LOD filtered
  // out, so distant water (smooth normals) still reflects a wide, correctly
  // bright streak while close water breaks it into sharp glints.
  vec3 L = uMoonDir;
  vec3 H = normalize(L + V);
  float NdotH = max(dot(N, H), 1e-3);
  float m2 = 0.0004 + uMoonSize * uMoonSize * 0.5 + w.lostVar + micro.z;
  float cos2 = NdotH * NdotH;
  float D = exp((cos2 - 1.0) / (cos2 * m2)) / (PI * m2 * cos2 * cos2);
  float fresnelL = 0.02 + 0.98 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
  float NdotL = dot(N, L);
  // Moon irradiance = disc radiance × solid angle (π r²), so a mirror-flat
  // patch reflects the moon at about its own brightness × Fresnel.
  // uMoonSpecular = 1 is physical; larger values exaggerate the path.
  float moonIrradiance = uMoonIntensity * PI * uMoonSize * uMoonSize * uMoonSpecular;
  vec3 glitter = uMoonColor * moonIrradiance * D * fresnelL / (4.0 * NdotV) * smoothstep(-0.05, 0.1, NdotL);
  col += glitter;

  // --- Distance fog -----------------------------------------------------------
  // Fades to skyColor at the horizon in this azimuth (incl. the moon halo),
  // i.e. exactly what the sky dome shows just above the sea line.
  float fog = 1.0 - exp(-pow(uFogDensity * dist, 2.0));
  col = mix(col, fogColor(-V), fog);

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
