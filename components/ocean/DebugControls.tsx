'use client';

import { folder, Leva, monitor, useControls } from 'leva';
import { useEffect, useMemo } from 'react';
import type { OceanState } from './state';

/**
 * Developer tuning panel (leva). Loaded only in development, or with `?debug`
 * in production, so leva never ships in the main bundle.
 *
 * Every control maps to a path in `ocean.params`; on change the value is
 * written there, the derived uniforms are rebuilt (`applyParams`) and the
 * scene is asked to re-render for the few settings that are React props
 * (toggles, post-processing).
 */

type Control = { path: string; label: string } & (
  | { min: number; max: number; step: number }
  | { color: true }
  | { toggle: true }
);

const GROUPS: Record<string, Control[]> = {
  Waves: [
    { path: 'waves.amplitude', label: 'amplitude', min: 0, max: 1.6, step: 0.01 },
    { path: 'waves.speed', label: 'speed', min: 0, max: 2, step: 0.01 },
    { path: 'waves.count', label: 'count', min: 1, max: 8, step: 1 },
  ],
  Glow: [
    { path: 'glow.colorA', label: 'colour (core)', color: true },
    { path: 'glow.colorB', label: 'colour (teal)', color: true },
    { path: 'glow.intensity', label: 'intensity', min: 0, max: 4, step: 0.01 },
    { path: 'glow.ambient', label: 'ambient', min: 0, max: 2, step: 0.01 },
    { path: 'glow.crest', label: 'crest glow', min: 0, max: 8, step: 0.01 },
    { path: 'glow.crestThreshold', label: 'crest threshold', min: 0, max: 0.8, step: 0.01 },
    { path: 'glow.ripple', label: 'touch glow', min: 0, max: 10, step: 0.01 },
    { path: 'glow.granularity', label: 'granularity', min: 0, max: 1, step: 0.01 },
    { path: 'glow.sparkleScale', label: 'sparkle scale', min: 0.5, max: 8, step: 0.1 },
  ],
  Plankton: [
    { path: 'glow.patchCoverage', label: 'density', min: 0, max: 1, step: 0.01 },
    { path: 'glow.baseDensity', label: 'between patches', min: 0, max: 1, step: 0.01 },
    { path: 'glow.noiseScale', label: 'noise scale', min: 0.005, max: 0.2, step: 0.001 },
    { path: 'glow.drift', label: 'drift', min: 0, max: 0.2, step: 0.001 },
    { path: 'plankton.enabled', label: 'particles', toggle: true },
    { path: 'plankton.brightness', label: 'particle brightness', min: 0, max: 4, step: 0.01 },
    { path: 'plankton.size', label: 'particle size', min: 0.2, max: 4, step: 0.01 },
    { path: 'life.enabled', label: 'under-surface life', toggle: true },
    { path: 'life.interval', label: 'fish interval (s)', min: 0.5, max: 20, step: 0.1 },
  ],
  Water: [
    { path: 'water.fogDensity', label: 'fog density', min: 0, max: 0.006, step: 0.0001 },
    { path: 'water.moonSpecular', label: 'moon path', min: 0, max: 8, step: 0.01 },
    { path: 'water.microNormals', label: 'micro ripples', min: 0, max: 1.5, step: 0.01 },
  ],
  Moon: [
    { path: 'moon.azimuth', label: 'azimuth', min: -180, max: 180, step: 0.5 },
    { path: 'moon.elevation', label: 'elevation', min: -2, max: 60, step: 0.1 },
    { path: 'moon.size', label: 'size', min: 0.2, max: 4, step: 0.01 },
    { path: 'moon.intensity', label: 'brightness', min: 0, max: 2, step: 0.01 },
  ],
  Ripples: [
    { path: 'ripple.glowLifetime', label: 'trail decay (s)', min: 0.2, max: 8, step: 0.05 },
    { path: 'ripple.damping', label: 'ripple damping', min: 0.01, max: 0.95, step: 0.01 },
    { path: 'ripple.waveSpeed', label: 'ripple speed', min: 0.5, max: 6, step: 0.05 },
    { path: 'ripple.brushRadius', label: 'brush radius', min: 0.2, max: 2.5, step: 0.01 },
  ],
  Camera: [
    { path: 'camera.bobStrength', label: 'bob strength', min: 0, max: 2, step: 0.01 },
    { path: 'camera.rollStrength', label: 'roll strength', min: 0, max: 1.5, step: 0.01 },
    { path: 'camera.drift', label: 'boat drift (m/s)', min: 0, max: 2, step: 0.01 },
  ],
  Post: [
    { path: 'post.bloomThreshold', label: 'bloom threshold', min: 0, max: 2, step: 0.01 },
    { path: 'post.bloomIntensity', label: 'bloom intensity', min: 0, max: 5, step: 0.01 },
    { path: 'post.bloomRadius', label: 'bloom radius', min: 0, max: 1, step: 0.01 },
    { path: 'post.vignette', label: 'vignette', min: 0, max: 1, step: 0.01 },
    { path: 'post.grain', label: 'grain', min: 0, max: 1, step: 0.01 },
    { path: 'post.exposure', label: 'exposure', min: 0.2, max: 3, step: 0.01 },
  ],
};

/** Paths whose changes need a React re-render (not just new uniform values). */
const RERENDER = /^(plankton\.enabled|life\.enabled|post\.)/;

const keyOf = (path: string) => path.replace('.', '_');

function getPath(root: object, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], root);
}

function setPath(root: object, path: string, value: unknown) {
  const keys = path.split('.');
  const last = keys.pop() as string;
  const target = keys.reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], root) as Record<string, unknown>;
  target[last] = value;
}

export interface DebugControlsProps {
  ocean: OceanState;
  /** Called when a setting that is a React prop changed. */
  onRerender: () => void;
}

export default function DebugControls({ ocean, onRerender }: DebugControlsProps) {
  const schema = useMemo(() => {
    const groups: Record<string, unknown> = {
      Stats: folder({
        fps: monitor(() => ocean.stats.fps, { graph: true, interval: 200 }),
        tier: monitor(() => ['low', 'medium', 'high'][ocean.stats.tier], { interval: 500 }),
        dpr: monitor(() => ocean.stats.dpr, { interval: 500 }),
      }),
    };
    for (const [name, controls] of Object.entries(GROUPS)) {
      const entries: Record<string, unknown> = {};
      for (const c of controls) {
        const value = getPath(ocean.params, c.path);
        if ('min' in c) entries[keyOf(c.path)] = { label: c.label, value, min: c.min, max: c.max, step: c.step };
        else entries[keyOf(c.path)] = { label: c.label, value };
      }
      groups[name] = folder(entries as Parameters<typeof folder>[0], { collapsed: name !== 'Glow' });
    }
    return groups;
  }, [ocean]);

  const values = useControls(schema as Parameters<typeof useControls>[0]) as Record<string, unknown>;

  useEffect(() => {
    let rerender = false;
    for (const controls of Object.values(GROUPS)) {
      for (const c of controls) {
        const next = values[keyOf(c.path)];
        if (next === undefined || next === getPath(ocean.params, c.path)) continue;
        setPath(ocean.params, c.path, next);
        if (RERENDER.test(c.path)) rerender = true;
      }
    }
    ocean.applyParams();
    if (rerender) onRerender();
  }, [values, ocean, onRerender]);

  return <Leva collapsed={false} titleBar={{ title: 'luminescent ocean' }} />;
}
