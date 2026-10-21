import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { directionFromAngles } from './colors';
import { useOcean } from './state';
import type { SurfaceSample } from './waves';

const UP = new THREE.Vector3(0, 1, 0);
/** Waves shorter than these (metres) average out under the hull (see WaveField.sample). */
const HULL_HEAVE = 1.4;
const HULL_TILT = 4.5;

/**
 * "Sitting in a small boat" camera.
 *
 * - Look-around: OrbitControls (damped) drive an invisible proxy camera that
 *   orbits a target 1 cm in front of it, i.e. it rotates in place. Only the
 *   proxy's orientation is used.
 * - Boat: the hull's height and tilt come from sampling the *same* Gerstner
 *   sum the GPU renders (waves.ts) under the boat, low-passed by hull length
 *   and smoothed by damped springs, so it rides the swell instead of
 *   tracking every ripple.
 * - Final camera = boat position + tilt * (eye offset), orientation = tilt * look.
 *   Because the eye sits above the pivot, roll also sways it sideways a little.
 *
 * Touch: one finger is reserved for touching the water, two fingers look around.
 */
export function CameraRig() {
  const ocean = useOcean();
  const camera = useThree((s) => s.camera);
  const domElement = useThree((s) => s.gl.domElement);

  const proxy = useMemo(() => new THREE.PerspectiveCamera(), []);
  const controls = useMemo(() => {
    const { camera: cam } = ocean.params;
    const c = new OrbitControls(proxy, domElement);
    c.enableDamping = true;
    c.dampingFactor = 0.075;
    c.enableZoom = false;
    c.enablePan = false;
    // Negative speed = "grab the world" panorama drag (like street-level photo viewers).
    c.rotateSpeed = -0.32;
    c.minPolarAngle = THREE.MathUtils.degToRad(90 - cam.maxLookDown);
    c.maxPolarAngle = THREE.MathUtils.degToRad(90 + cam.maxLookUp);
    c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: null, RIGHT: THREE.MOUSE.ROTATE };
    c.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };

    proxy.position.set(0, 0, 0);
    const forward = directionFromAngles(cam.initialYaw, cam.initialPitch);
    c.target.copy(forward).multiplyScalar(0.01);
    c.update();
    return c;
  }, [ocean, proxy, domElement]);

  useEffect(() => () => controls.dispose(), [controls]);
  useEffect(() => {
    ocean.debug.camera = camera;
    ocean.debug.controls = controls;
  }, [ocean, camera, controls]);

  // Pre-allocated scratch objects: nothing is allocated inside useFrame.
  const scratch = useMemo(
    () => ({
      sample: { height: 0, nx: 0, ny: 1, nz: 0 } as SurfaceSample,
      tilt: new THREE.Quaternion(),
      normal: new THREE.Vector3(),
      eye: new THREE.Vector3(),
      driftDir: new THREE.Vector2(),
      // Spring state: height and the two horizontal components of the hull normal.
      y: 0,
      vy: 0,
      nx: 0,
      vnx: 0,
      nz: 0,
      vnz: 0,
      initialised: false,
    }),
    [],
  );

  useFrame((_, delta) => {
    const dt = Math.min(delta, 1 / 20);
    const p = ocean.params.camera;
    const t = ocean.time;
    const s = scratch;

    controls.update();

    // --- Boat drift --------------------------------------------------------
    const driftAngle = THREE.MathUtils.degToRad(p.driftDirection);
    s.driftDir.set(Math.sin(driftAngle), -Math.cos(driftAngle));
    ocean.boat.addScaledVector(s.driftDir, p.drift * dt);
    const bx = ocean.boat.x;
    const bz = ocean.boat.y;

    // --- Hull height and tilt from the wave field ---------------------------
    // Height follows the surface fairly closely (a small boat lifts on chop
    // too); tilt only follows waves long enough to rock the whole hull.
    const w = ocean.waves;
    const targetY = w.sample(bx, bz, t, s.sample, HULL_HEAVE).height;
    w.sample(bx, bz, t, s.sample, HULL_TILT);
    const targetNx = s.sample.nx / s.sample.ny;
    const targetNz = s.sample.nz / s.sample.ny;

    if (!s.initialised) {
      s.y = targetY;
      s.nx = targetNx;
      s.nz = targetNz;
      s.initialised = true;
    }

    // Damped springs (semi-implicit Euler). A boat is heavy: it lags the
    // water slightly and overshoots a touch, which reads as buoyancy.
    const omegaY = 2.4;
    const zetaY = 0.55;
    s.vy += (omegaY * omegaY * (targetY - s.y) - 2 * zetaY * omegaY * s.vy) * dt;
    s.y += s.vy * dt;
    const omegaN = 1.4;
    const zetaN = 0.8;
    s.vnx += (omegaN * omegaN * (targetNx - s.nx) - 2 * zetaN * omegaN * s.vnx) * dt;
    s.nx += s.vnx * dt;
    s.vnz += (omegaN * omegaN * (targetNz - s.nz) - 2 * zetaN * omegaN * s.vnz) * dt;
    s.nz += s.vnz * dt;

    // --- Compose the final camera --------------------------------------------
    s.normal.set(s.nx * p.rollStrength, 1, s.nz * p.rollStrength).normalize();
    s.tilt.setFromUnitVectors(UP, s.normal);

    s.eye.set(0, p.height, 0).applyQuaternion(s.tilt);
    camera.position.set(bx + s.eye.x, s.y * p.bobStrength + s.eye.y, bz + s.eye.z);
    camera.quaternion.multiplyQuaternions(s.tilt, proxy.quaternion);

    ocean.uniforms.uOrigin.value.set(bx, bz);
  }, -50);

  return null;
}
