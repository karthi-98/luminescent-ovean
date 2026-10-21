// Plankton particles — fragment stage: a soft round glow, additively blended.
varying vec3 vColor;
varying float vSoftness;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot(c, c) * 4.0;
  // Shallow cells are crisp points, deeper ones are blurred by the water.
  float falloff = mix(7.0, 3.0, vSoftness);
  float a = exp(-r2 * falloff) * (1.0 - smoothstep(0.8, 1.0, r2));
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor * a, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
