import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The harness page `threeforge analyze` ships inside the package (dist/cli-app). Decoders are copied into
// cli-app/public by scripts/copy-decoders.mjs before the build.
export default defineConfig({
  root: 'cli-app',
  base: './',
  publicDir: 'public',
  build: { outDir: '../dist/cli-app', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 4000 },
  resolve: {
    alias: [{ find: 'threeforge', replacement: fileURLToPath(new URL('./src/index.ts', import.meta.url)) }],
  },
});
