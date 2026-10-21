// ---------------------------------------------------------------------------
// Water surface — vertex stage.
//
// The mesh is a flat radial grid centred on the boat (dense under the camera,
// sparse towards the 6 km horizon), so the sea has no edge in any direction.
// Each vertex is displaced by the Gerstner sum at its *rest* position; waves
// shorter than the local grid spacing are faded out (see waveLod) so the
// sparse far rings never alias.
// ---------------------------------------------------------------------------
#include <ocean_common>
#include <ocean_waves>

uniform vec2 uGridSpacing;  // (min spacing near the camera, spacing growth per metre)

varying vec3 vWorldPos;     // displaced world position
varying vec2 vRestXZ;       // undisplaced world XZ ("which water particle is this")

void main() {
  vec2 local = position.xz;
  vec2 rest = local + uOrigin;
  float spacing = max(uGridSpacing.x, length(local) * uGridSpacing.y);

  vec3 world = vec3(rest.x, 0.0, rest.y) + gerstnerDisplacement(rest, uTime, spacing);

  vWorldPos = world;
  vRestXZ = rest;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
