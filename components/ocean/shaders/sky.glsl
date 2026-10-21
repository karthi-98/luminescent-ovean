// ---------------------------------------------------------------------------
// ocean_sky — the night sky as a function of view direction.
//
// Shared by the sky dome, the water (Fresnel reflection) and the distance fog:
// the fog colour for a pixel is skyColor() at the horizon in that pixel's
// azimuth, so the far water fades into *exactly* the colour of the sky behind
// it and the horizon has no seam in any direction.
// ---------------------------------------------------------------------------

uniform vec3 uSkyZenith;    // scene-linear (see colors.ts: inverted through ACES)
uniform vec3 uSkyHorizon;
uniform float uSkyFalloff;  // gradient sharpness above the horizon
uniform vec3 uMoonDir;      // unit vector towards the moon
uniform vec3 uMoonColor;
uniform float uMoonSize;    // angular radius, radians
uniform float uMoonIntensity;
uniform float uMoonHalo;

// Angle between two unit vectors; stable for tiny angles (unlike acos(dot)).
float angleBetween(vec3 a, vec3 b) {
  return 2.0 * asin(clamp(length(a - b) * 0.5, 0.0, 1.0));
}

// Zenith → horizon gradient. Directions below the horizon reuse the horizon
// colour: that is what the fogged sea converges to far away.
vec3 skyGradient(vec3 dir) {
  float h = max(dir.y, 0.0);
  float t = 1.0 - exp(-h * uSkyFalloff);
  return mix(uSkyHorizon, uSkyZenith, t);
}

// Moonlight scattered by the atmosphere: a tight corona plus a wide, faint
// glow that lifts the horizon in the moon's azimuth.
vec3 moonHalo(vec3 dir) {
  float a = angleBetween(dir, uMoonDir);
  float corona = exp(-a * 24.0);
  float scatter = exp(-a * 3.2);
  return uMoonColor * uMoonHalo * (0.22 * corona + 0.045 * scatter);
}

vec3 skyColor(vec3 dir) {
  return skyGradient(dir) + moonHalo(dir);
}

// Horizon colour in the azimuth of `dir`: the colour distance fog fades to.
vec3 fogColor(vec3 dir) {
  vec3 flat_ = vec3(dir.x, 0.0, dir.z);
  float len = length(flat_);
  return skyColor(len > 1e-5 ? flat_ / len : vec3(0.0, 0.0, -1.0));
}
