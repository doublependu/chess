import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import { execSync } from 'node:child_process';

// "v.<first 4 characters of the deployed git commit>"
function commitSha() {
  const env = process.env.WORKERS_CI_COMMIT_SHA || process.env.CF_PAGES_COMMIT_SHA || process.env.GITHUB_SHA;
  if (env) return env;
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'dev0';
  }
}
const VERSION = 'v.' + commitSha().slice(0, 4);

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(VERSION),
  },
  plugins: [
    {
      name: 'app-version-html',
      transformIndexHtml: (html) => html.replaceAll('%APP_VERSION%', VERSION),
    },
  ],
  // Rapier's wasm glue must not be pre-bundled (it would end up as two module instances).
  optimizeDeps: { exclude: ['@dimforge/rapier3d'] },
  worker: {
    format: 'es',
    plugins: () => [wasm()],
  },
  build: {
    target: 'es2022',
    modulePreload: { polyfill: false },
    reportCompressedSize: true,
    chunkSizeWarningLimit: 1500,
  },
  server: { host: true },
  preview: { host: true },
  test: {
    include: ['tests/**/*.test.js'],
    testTimeout: 30000,
  },
});
