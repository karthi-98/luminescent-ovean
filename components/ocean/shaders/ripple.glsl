// ---------------------------------------------------------------------------
// ocean_ripple — reading the interaction heightfield from other shaders.
// The simulation domain is a square of side uRippleDomain.z centred on
// uRippleDomain.xy (world XZ); outside it the water is undisturbed.
// ---------------------------------------------------------------------------
uniform sampler2D uRippleTex;
uniform vec3 uRippleDomain;       // (centre X, centre Z, size in metres)
uniform float uRippleTexel;       // 1 / resolution
uniform float uRippleDisplacement;
uniform float uRippleNormal;

vec2 rippleUV(vec2 worldXZ) {
  return (worldXZ - uRippleDomain.xy) / uRippleDomain.z + 0.5;
}

// Soft fade near the domain edge so nothing ever ends in a hard line.
float rippleMask(vec2 uv) {
  vec2 e = smoothstep(0.0, 0.08, uv) * smoothstep(0.0, 0.08, 1.0 - uv);
  return e.x * e.y;
}

// (height now, height before, glow energy, 1) — zero outside the domain.
// textureLod: safe in vertex shaders and inside non-uniform branches.
vec4 rippleState(vec2 worldXZ) {
  vec2 uv = rippleUV(worldXZ);
  float m = rippleMask(uv);
  if (m <= 0.0) return vec4(0.0);
  return textureLod(uRippleTex, uv, 0.0) * m;
}

// Height gradient (∂h/∂x, ∂h/∂z) in height-units per metre.
vec2 rippleGradient(vec2 worldXZ) {
  vec2 uv = rippleUV(worldXZ);
  float m = rippleMask(uv);
  if (m <= 0.0) return vec2(0.0);
  float t = uRippleTexel;
  float hx = textureLod(uRippleTex, uv + vec2(t, 0.0), 0.0).r - textureLod(uRippleTex, uv - vec2(t, 0.0), 0.0).r;
  float hz = textureLod(uRippleTex, uv + vec2(0.0, t), 0.0).r - textureLod(uRippleTex, uv - vec2(0.0, t), 0.0).r;
  return vec2(hx, hz) * m / (2.0 * t * uRippleDomain.z);
}
