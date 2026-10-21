varying vec3 vColor;
varying float vIntensity;

void main() {
  // Gaussian point-spread so stars look like soft photographic points.
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot(c, c) * 4.0;
  float psf = exp(-r2 * 5.0);
  float energy = psf * vIntensity;
  if (energy < 0.0005) discard;
  gl_FragColor = vec4(vColor * energy, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
