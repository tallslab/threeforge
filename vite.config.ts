import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Dev/test app lives in test/app and imports the library source directly.
export default defineConfig({
  root: 'test/app',
  // Downloaded glTF assets and decoders (test/assets/files, gitignored) are served from the site root.
  publicDir: fileURLToPath(new URL('./test/assets/files', import.meta.url)),
  server: { port: 5179, strictPort: true },
  resolve: {
    alias: [
      { find: 'threeforge/overlay', replacement: fileURLToPath(new URL('./src/overlay/index.ts', import.meta.url)) },
      { find: 'threeforge', replacement: fileURLToPath(new URL('./src/index.ts', import.meta.url)) },
    ],
  },
});
