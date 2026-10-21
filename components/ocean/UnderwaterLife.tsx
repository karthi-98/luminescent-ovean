import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { MAX_SOURCES } from './RippleSim';
import { MAX_FISH, useOcean } from './state';

interface Fish {
  active: boolean;
  x: number;
  z: number;
  prevX: number;
  prevZ: number;
  heading: number;
  speed: number;
  turn: number;
  age: number;
  life: number;
  length: number;
  wiggle: number;
}

/**
 * Occasional small fish darting through the plankton just below the surface.
 *
 * Fish are simulated on the CPU (a handful at most). Each one
 *  - feeds glow energy into the interaction field along its path (energy
 *    only, no ripples: they are under water), so its wake sparkles and fades
 *    exactly like a pointer trail, and
 *  - is drawn by the water shader as a soft, blurred streak (uFish / uFishGlow),
 *    the fish itself seen through half a metre of water.
 */
export function UnderwaterLife() {
  const ocean = useOcean();
  const camera = useThree((s) => s.camera);

  const fish = useMemo<Fish[]>(
    () =>
      Array.from({ length: Math.min(MAX_FISH, MAX_SOURCES) }, () => ({
        active: false,
        x: 0,
        z: 0,
        prevX: 0,
        prevZ: 0,
        heading: 0,
        speed: 0,
        turn: 0,
        age: 0,
        life: 1,
        length: 1,
        wiggle: 0,
      })),
    [],
  );
  const state = useMemo(() => ({ timer: 1.5, anyActive: false, view: new THREE.Vector3() }), []);

  const clear = () => {
    const segments = ocean.uniforms.uFish.value;
    const glow = ocean.uniforms.uFishGlow.value;
    for (let i = 0; i < fish.length; i++) {
      fish[i].active = false;
      glow[i] = 0;
      segments.fill(0, i * 4, i * 4 + 4);
      ocean.ripple?.setSource(i, 0, 0, 0, 0, 0, 0.45);
    }
    state.anyActive = false;
  };
  useEffect(() => {
    ocean.debug.life = state;
    return clear;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useFrame((_, delta) => {
    const dt = Math.min(delta, 1 / 20);
    const p = ocean.params.life;
    if (!p.enabled) {
      if (state.anyActive) clear();
      return;
    }

    // --- Spawning (Poisson process, mean interval p.interval) ----------------
    state.timer -= dt;
    if (state.timer <= 0) {
      state.timer = -Math.log(1 - Math.random()) * p.interval + 0.4;
      let slot: Fish | null = null;
      for (const f of fish) if (!f.active) slot = f;
      if (slot) {
        state.anyActive = true;
        // Mostly where the viewer is looking, so the moments aren't wasted.
        camera.getWorldDirection(state.view);
        const yaw = Math.atan2(state.view.x, state.view.z);
        const angle = Math.random() < 0.8 ? yaw + (Math.random() - 0.5) * 1.6 : Math.random() * Math.PI * 2;
        const dist = 7 + Math.random() * 20;
        slot.x = slot.prevX = ocean.boat.x + Math.sin(angle) * dist;
        slot.z = slot.prevZ = ocean.boat.y + Math.cos(angle) * dist;
        // Darting roughly across the line of sight reads best.
        slot.heading = angle + (Math.random() < 0.5 ? 1 : -1) * (Math.PI / 2 + (Math.random() - 0.5) * 0.9);
        slot.speed = 5 + Math.random() * 4.5;
        slot.turn = (Math.random() - 0.5) * 1.2;
        slot.age = 0;
        slot.life = 1.1 + Math.random() * 1.3;
        slot.length = 0.9 + Math.random() * 0.9;
        slot.wiggle = Math.random() * 10;
        slot.active = true;
      }
    }

    // --- Motion + outputs --------------------------------------------------------
    const segments = ocean.uniforms.uFish.value;
    const glow = ocean.uniforms.uFishGlow.value;
    for (let i = 0; i < fish.length; i++) {
      const f = fish[i];
      if (!f.active) continue;
      f.age += dt;
      if (f.age >= f.life) {
        f.active = false;
        glow[i] = 0;
        ocean.ripple?.setSource(i, 0, 0, 0, 0, 0, 0.45);
        continue;
      }
      f.prevX = f.x;
      f.prevZ = f.z;
      // Slight curve plus a tail-beat wiggle.
      f.heading += (f.turn + Math.sin(f.age * 9 + f.wiggle) * 0.8) * dt;
      f.x += Math.sin(f.heading) * f.speed * dt;
      f.z += Math.cos(f.heading) * f.speed * dt;

      // Brightest mid-dash, fading in and out.
      const envelope = Math.sin((Math.PI * f.age) / f.life);
      const intensity = envelope * p.brightness;
      glow[i] = intensity;
      segments[i * 4] = f.x - Math.sin(f.heading) * f.length;
      segments[i * 4 + 1] = f.z - Math.cos(f.heading) * f.length;
      segments[i * 4 + 2] = f.x;
      segments[i * 4 + 3] = f.z;
      ocean.ripple?.setSource(i, f.prevX, f.prevZ, f.x, f.z, 0.07 * intensity, 0.45);
    }
  });

  return null;
}
