// Water surface — fragment stage (stage 2: geometry preview shading).
#include <ocean_common>
#include <ocean_sky>
#include <ocean_waves>

uniform vec3 uWaterColor;
uniform float uFogDensity;

varying vec3 vWorldPos;
varying vec2 vRestXZ;

void main() {
  vec3 toEye = cameraPosition - vWorldPos;
  float dist = length(toEye);
  vec3 V = toEye / dist;

  // Per-pixel normals from the analytic Gerstner frame.
  float footprint = length(fwidth(vRestXZ));
  WaveSample w = gerstnerSample(vRestXZ, uTime, footprint);
  vec3 N = w.normal;

  // Preview shading: sky-tinted wrap lighting so the wave shapes read.
  float facing = clamp(dot(N, V), 0.0, 1.0);
  vec3 col = uWaterColor * (0.6 + 0.8 * N.y) + skyColor(reflect(-V, N) * vec3(1.0, sign(reflect(-V, N).y), 1.0)) * (1.0 - facing) * 0.6;

  float fog = 1.0 - exp(-pow(uFogDensity * dist, 2.0));
  col = mix(col, fogColor(-V), fog);

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
