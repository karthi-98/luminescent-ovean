import type { NextConfig } from 'next';

/**
 * GLSL sources live in `components/ocean/shaders` and are imported as plain
 * strings (`import src from './water.frag'`). Turbopack (the default bundler
 * for `next dev` / `next build`) handles this with the built-in `raw` module
 * type; the webpack branch keeps `next build --webpack` working too.
 */
const shaderGlobs = ['*.glsl', '*.vert', '*.frag'] as const;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Keep the corner badge out of the fullscreen scene; errors still show as overlays.
  devIndicators: false,
  agentRules: false,
  turbopack: {
    rules: Object.fromEntries(shaderGlobs.map((glob) => [glob, { type: 'raw' as const }])),
  },
  webpack(config) {
    config.module.rules.push({ test: /\.(glsl|vert|frag)$/, type: 'asset/source' });
    return config;
  },
};

export default nextConfig;
