import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      { find: 'threeforge/overlay', replacement: fileURLToPath(new URL('./src/overlay/index.ts', import.meta.url)) },
      { find: 'threeforge', replacement: fileURLToPath(new URL('./src/index.ts', import.meta.url)) },
    ],
  },
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
  },
});
