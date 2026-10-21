import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { shaders } from './shaders';
import { useOcean } from './state';

/** Sky dome radius. Must stay inside camera.far; the water is drawn on top of it. */
const SKY_RADIUS = 8000;

/** Small deterministic PRNG so the star field is identical on every load. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STAR_COLORS: [number, number, number, number][] = [
  // r, g, b, relative frequency — blue-white to orange, like real star colour temperatures.
  [0.72, 0.82, 1.0, 0.25],
  [0.9, 0.94, 1.0, 0.35],
  [1.0, 0.97, 0.9, 0.25],
  [1.0, 0.86, 0.68, 0.15],
];

const GALACTIC_POLE = new THREE.Vector3(0.42, 0.52, -0.74).normalize();

function createStarGeometry(count: number): THREE.BufferGeometry {
  const rand = mulberry32(1337);
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const brightness = new Float32Array(count);
  const twinkle = new Float32Array(count * 2);
  const colors = new Float32Array(count * 3);

  // Basis of the galactic plane, used to crowd ~35% of the stars into the Milky Way band.
  const u = new THREE.Vector3().crossVectors(GALACTIC_POLE, new THREE.Vector3(0, 1, 0)).normalize();
  const v = new THREE.Vector3().crossVectors(GALACTIC_POLE, u);
  const dir = new THREE.Vector3();

  for (let i = 0; i < count; i++) {
    do {
      if (rand() < 0.35) {
        const angle = rand() * Math.PI * 2;
        // Box–Muller for a gaussian spread around the band.
        const g = Math.sqrt(-2 * Math.log(rand() + 1e-9)) * Math.cos(2 * Math.PI * rand());
        dir.copy(u).multiplyScalar(Math.cos(angle)).addScaledVector(v, Math.sin(angle));
        dir.addScaledVector(GALACTIC_POLE, g * 0.12).normalize();
      } else {
        // Uniform on the sphere: uniform height, uniform azimuth.
        const y = rand() * 2 - 1;
        const r = Math.sqrt(1 - y * y);
        const phi = rand() * Math.PI * 2;
        dir.set(r * Math.cos(phi), y, r * Math.sin(phi));
      }
    } while (dir.y < -0.02); // nothing below the horizon: the sea hides it anyway

    positions.set([dir.x, dir.y, dir.z], i * 3);

    // Many faint stars, very few bright ones (steep power law).
    const m = rand();
    brightness[i] = 0.14 + 0.9 * Math.pow(m, 6) + (m > 0.996 ? 0.9 : 0);
    sizes[i] = 0.6 + 0.8 * Math.pow(m, 3) + rand() * 0.25;
    twinkle[i * 2] = 0.8 + rand() * 3.2;
    twinkle[i * 2 + 1] = rand() * Math.PI * 2;

    let pick = rand();
    let c = STAR_COLORS[0];
    for (const candidate of STAR_COLORS) {
      c = candidate;
      if ((pick -= candidate[3]) <= 0) break;
    }
    colors.set([c[0], c[1], c[2]], i * 3);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aBrightness', new THREE.BufferAttribute(brightness, 1));
  geometry.setAttribute('aTwinkle', new THREE.BufferAttribute(twinkle, 2));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** Gradient sky dome with the moon, plus the twinkling star field. */
export function Sky() {
  const ocean = useOcean();
  const camera = useThree((s) => s.camera);
  const group = useRef<THREE.Group>(null);
  const starCount = ocean.params.sky.starCount;

  const skyGeometry = useMemo(() => new THREE.SphereGeometry(1, 64, 32), []);
  const skyMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        name: 'OceanSky',
        uniforms: { ...ocean.uniforms },
        vertexShader: shaders.sky.vertex,
        fragmentShader: shaders.sky.fragment,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
      }),
    [ocean],
  );

  const starGeometry = useMemo(() => createStarGeometry(starCount), [starCount]);
  const starMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        name: 'OceanStars',
        uniforms: { ...ocean.uniforms },
        vertexShader: shaders.stars.vertex,
        fragmentShader: shaders.stars.fragment,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [ocean],
  );

  useEffect(() => () => skyGeometry.dispose(), [skyGeometry]);
  useEffect(() => () => skyMaterial.dispose(), [skyMaterial]);
  useEffect(() => () => starGeometry.dispose(), [starGeometry]);
  useEffect(() => () => starMaterial.dispose(), [starMaterial]);

  // The dome travels with the eye so it is always "infinitely" far away.
  useFrame(() => {
    group.current?.position.copy(camera.position);
  });

  return (
    <group ref={group}>
      <mesh
        geometry={skyGeometry}
        material={skyMaterial}
        scale={SKY_RADIUS}
        renderOrder={-100}
        frustumCulled={false}
      />
      <points
        geometry={starGeometry}
        material={starMaterial}
        scale={SKY_RADIUS * 0.98}
        renderOrder={-90}
        frustumCulled={false}
      />
    </group>
  );
}
