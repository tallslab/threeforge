import { defineConfig } from '@playwright/test';
import type { ForgeOptions } from './test/e2e/fixtures.js';

export default defineConfig<ForgeOptions>({
  testDir: 'test/e2e',
  // Baselines are committed once, without platform suffixes; tolerances absorb SwiftShader differences.
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5179',
    viewport: { width: 800, height: 600 },
    backend: 'webgl2',
  },
  webServer: {
    command: 'pnpm exec vite --config vite.config.ts',
    url: 'http://localhost:5179',
    reuseExistingServer: true,
    timeout: 30_000,
  },
  projects: [
    {
      name: 'webgl2',
      use: {
        browserName: 'chromium',
        backend: 'webgl2',
        launchOptions: { args: ['--ignore-gpu-blocklist'] },
      },
    },
    {
      // Best effort: skipped by the fixture when no WebGPU adapter is available.
      name: 'webgpu',
      use: {
        browserName: 'chromium',
        channel: 'chromium',
        backend: 'webgpu',
        launchOptions: {
          args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist'],
        },
      },
    },
  ],
});
