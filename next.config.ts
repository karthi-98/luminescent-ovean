import type { NextConfig } from 'next';

/**
 * GLSL sources live in `components/ocean/shaders` and are imported as plain
 * strings (`import src from './water.frag'`). Turbopack (the default bundler
 * for `next dev` / `next build`) handles this with the built-in `raw` module
 * type; the webpack branch keeps `next build --webpack` working too.
 */
const shaderGlobs = ['*.glsl', '*.vert', '*.frag'] as const;

/**
 * GitHub Pages serves the site from /<repo>/. The deploy workflow sets
 * PAGES_BASE_PATH (e.g. "/luminescent-ovean"); locally it is empty, so
 * `npm run dev` / `npm start` keep serving from the root.
 */
const basePath = process.env.PAGES_BASE_PATH || '';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Fully static site: `next build` writes plain files to out/ (GitHub Pages).
  output: 'export',
  basePath,
  assetPrefix: basePath || undefined,
  trailingSlash: true,
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
