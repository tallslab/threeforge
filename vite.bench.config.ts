import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The device bench page (bench-app) deploys to GitHub Pages under /<repo>/, hence the relative base. Assets
// (decoders, the crowd's characters, the water normals, devices.json) land in bench-app/public through
// scripts/bench-app-assets.mjs before dev or build.
export default defineConfig({
  root: 'bench-app',
  base: './',
  publicDir: 'public',
  server: { port: 5180, strictPort: true, fs: { allow: [fileURLToPath(new URL('.', import.meta.url))] } },
  build: { outDir: '../dist/bench-app', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 4000 },
  resolve: {
    alias: [
      { find: 'threeforge/overlay', replacement: fileURLToPath(new URL('./src/overlay/index.ts', import.meta.url)) },
      { find: 'threeforge', replacement: fileURLToPath(new URL('./src/index.ts', import.meta.url)) },
    ],
  },
});
