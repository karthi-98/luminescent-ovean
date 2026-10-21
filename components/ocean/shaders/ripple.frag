// ---------------------------------------------------------------------------
// Interaction heightfield — one simulation step (ping-pong, 60 Hz fixed step).
//
// State texture (RGBA half float):
//   R = height now, G = height one step ago      (wave equation)
//   B = glow energy: how stirred the plankton is (what the water shader shows)
//
// Height: discrete 2D wave equation
//   h' = (2h − h_prev + c² ∇²h) · damping
// Energy: diffuses, decays exponentially, and is fed by anything that moves
// the water (pointer strokes, splashes, passing ripples, fish). Keeping it
// separate from the oscillating height is what makes trails glow steadily
// and fade out smoothly instead of flickering with every ripple.
//
// The domain is centred on the boat; when the boat moves by whole texels the
// previous state is read with `uShift` so the field stays fixed to the world.
// ---------------------------------------------------------------------------

uniform sampler2D uState;
uniform vec2 uTexel;          // 1 / resolution
uniform vec2 uShift;          // UV offset from recentring (first sub-step only)
uniform float uC2;            // wave speed², texels²/step (stable < 0.5)
uniform float uDamping;       // height damping per step
uniform float uEnergyDecay;   // energy multiplier per step
uniform float uDiffusion;     // energy diffusion per step (stable < 0.25)
uniform float uMotionGlow;    // energy created per unit of height change

// Pointer stroke: a capsule from (x0, y0) to (x1, y1) in UV.
uniform vec4 uStroke;
uniform vec3 uStrokeParams;   // (radius UV, target depth, target energy)

// Click / tap splash.
uniform vec4 uSplash;         // (u, v, radius UV, height impulse)
uniform float uSplashEnergy;

// Energy-only sources (glowing fish under the surface): capsules in UV.
#define MAX_SOURCES 4
uniform vec4 uSources[MAX_SOURCES];
uniform float uSourceEnergy[MAX_SOURCES];
uniform float uSourceRadius;

varying vec2 vUv;

vec4 state(vec2 uv) {
  vec2 p = uv + uShift;
  // Anything entering the domain from outside starts calm.
  if (p.x < 0.0 || p.y < 0.0 || p.x > 1.0 || p.y > 1.0) return vec4(0.0);
  return texture2D(uState, p);
}

float segmentDistance(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-10), 0.0, 1.0);
  return length(pa - ba * h);
}

void main() {
  vec2 uv = vUv;
  vec4 c = state(uv);
  vec4 n = state(uv + vec2(0.0, uTexel.y));
  vec4 s = state(uv - vec2(0.0, uTexel.y));
  vec4 e = state(uv + vec2(uTexel.x, 0.0));
  vec4 w = state(uv - vec2(uTexel.x, 0.0));

  // --- Height: wave equation ------------------------------------------------
  float h = c.r;
  float laplacian = n.r + s.r + e.r + w.r - 4.0 * h;
  float hNext = (2.0 * h - c.g + uC2 * laplacian) * uDamping;

  // Absorbing border: waves fade out near the edges instead of reflecting.
  vec2 edge = smoothstep(0.0, 0.06, uv) * smoothstep(0.0, 0.06, 1.0 - uv);
  hNext *= mix(0.85, 1.0, edge.x * edge.y);

  // --- Energy: diffusion + decay + stirring by moving water -----------------
  float energy = c.b + uDiffusion * (n.b + s.b + e.b + w.b - 4.0 * c.b);
  energy += abs(hNext - h) * uMotionGlow;

  // --- Sources -----------------------------------------------------------------
  // Inputs *displace* the water: the same push is applied to the current and
  // the previous height, so it adds no velocity. (Pushing only hNext would
  // act as a velocity kick that keeps deepening the dent for many steps.)
  float push = 0.0;

  // Pointer: pushes the water *down to* a target depth along the stroke and
  // lights the plankton it touches *up to* a target level. Targets rather
  // than increments, so a slow or lingering finger doesn't pile up depth or
  // energy (the brush is applied on every step it overlaps). Where the brush
  // holds the water it also cancels the water's velocity (see `hold` below),
  // otherwise the restoring force would keep charging it under a held brush
  // and release a big ring as soon as the brush moves on.
  float hold = 0.0;
  float r = uStrokeParams.x;
  if (r > 0.0) {
    float d = segmentDistance(uv, uStroke.xy, uStroke.zw);
    float brush = exp(-(d * d) / (r * r));
    hold = min(brush * 2.0, 1.0);
    push += max(hNext + brush * uStrokeParams.y, 0.0) * hold;
    energy = max(energy, brush * uStrokeParams.z) + brush * uStrokeParams.z * 0.01;
  }

  // Splash: a deeper, wider dent (rings spread out from it) and a burst of light.
  if (uSplash.z > 0.0) {
    float d = length(uv - uSplash.xy);
    float rs = uSplash.z;
    float profile = exp(-(d * d) / (rs * rs));
    push += profile * uSplash.w;
    energy += profile * uSplashEnergy;
  }
  hNext -= push;

  // Fish: light only, they swim below the surface.
  for (int i = 0; i < MAX_SOURCES; i++) {
    if (uSourceEnergy[i] <= 0.0) continue;
    float d = segmentDistance(uv, uSources[i].xy, uSources[i].zw);
    energy += exp(-(d * d) / (uSourceRadius * uSourceRadius)) * uSourceEnergy[i];
  }

  energy = clamp(energy * uEnergyDecay, 0.0, 6.0) * mix(0.9, 1.0, edge.x * edge.y);

  // Previous height: `h − push` turns the inputs into pure displacements; under
  // a holding brush it is blended to hNext, i.e. zero velocity.
  gl_FragColor = vec4(hNext, mix(h - push, hNext, hold), energy, 1.0);
}
