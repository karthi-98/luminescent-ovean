// Sky dome: a sphere centred on the camera, so a vertex's local position is
// also its world-space view direction.
varying vec3 vDir;

void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
