// Sky dome: gradient + moon (disc, maria, corona) + a faint Milky Way.
#include <ocean_common>
#include <ocean_noise>
#include <ocean_sky>

uniform float uMilkyWay;

varying vec3 vDir;

// Faint band of unresolved stars with darker dust lanes. Kept very subtle:
// it should read as texture in the sky, never compete with the water glow.
vec3 milkyWay(vec3 dir) {
  const vec3 pole = vec3(0.42, 0.52, -0.74); // normal of the galactic plane (any unit vector)
  float d = dot(dir, normalize(pole));
  float band = exp(-d * d * 22.0);
  if (band < 0.01) return vec3(0.0);
  float clouds = fbm3(dir * 3.2, 4) * 0.5 + 0.5;
  float lanes = smoothstep(0.35, 0.75, fbm3(dir * 7.0 + 4.1, 3) * 0.5 + 0.5);
  float core = exp(-d * d * 90.0);
  float intensity = band * clouds * (1.0 - 0.75 * lanes * core);
  // Atmospheric extinction: thick air near the horizon hides it.
  intensity *= smoothstep(0.02, 0.3, dir.y);
  return vec3(0.55, 0.62, 0.8) * intensity * 0.012 * uMilkyWay;
}

void main() {
  vec3 dir = normalize(vDir);
  vec3 col = skyColor(dir) + milkyWay(dir);

  // --- Moon disc --------------------------------------------------------
  float a = angleBetween(dir, uMoonDir);
  if (a < uMoonSize * 1.5) {
    float aa = fwidth(a) * 1.5;
    float disc = 1.0 - smoothstep(uMoonSize - aa, uMoonSize + aa, a);

    // Local 2D coordinates on the disc (-1..1).
    vec3 right = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)));
    vec3 up = cross(right, uMoonDir);
    vec2 uv = vec2(dot(dir - uMoonDir, right), dot(dir - uMoonDir, up)) / uMoonSize;

    // Limb darkening + darker maria ("seas") from low-frequency noise.
    float mu = sqrt(max(1.0 - dot(uv, uv), 0.0));
    float maria = smoothstep(0.05, 0.55, fbm3(vec3(uv * 1.7, 3.0), 4) * 0.5 + 0.5);
    float shade = (0.72 + 0.28 * mu) * (1.0 - 0.28 * maria);
    // Low moons look a touch warmer through the long air path.
    vec3 tint = mix(vec3(1.0, 0.93, 0.82), vec3(1.0), smoothstep(0.05, 0.4, uMoonDir.y));
    col = mix(col, uMoonColor * tint * uMoonIntensity * shade, disc);
  }

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
