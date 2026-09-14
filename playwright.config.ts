import { defineConfig } from '@playwright/test';
import type { ForgeOptions } from './test/e2e/fixtures.js';

const webgpuAdapter = process.env.FORGE_WEBGPU ?? (process.platform === 'linux' ? 'swiftshader' : 'native');

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
  webServer: [
    { command: 'pnpm exec vite --config vite.config.ts', url: 'http://localhost:5179', reuseExistingServer: true, timeout: 30_000 },
    // The device bench page (test/e2e/bench-app.spec.ts); its public dir is filled from the downloaded kits first.
    { command: 'node scripts/bench-app-assets.mjs && pnpm exec vite --config vite.bench.config.ts', url: 'http://localhost:5180', reuseExistingServer: true, timeout: 60_000 },
  ],
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
      // WebGPU needs a secure context (localhost qualifies). Adapter choice, via FORGE_WEBGPU:
      //   native (default on macOS/Windows): the machine's GPU through the full Chromium build.
      //   swiftshader (default on Linux): Dawn's software adapter in the headless shell. It works for single-shot
      //   tests, but drops the WebGPU instance when a page idles between test steps ("Device Lost"), so multi-step
      //   specs can fail there. The fixture skips the project when no adapter appears.
      name: 'webgpu',
      use: {
        browserName: 'chromium',
        backend: 'webgpu',
        ...(webgpuAdapter === 'native' ? { channel: 'chromium' } : {}),
        launchOptions: {
          args:
            webgpuAdapter === 'native'
              ? ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
              : ['--enable-features=WebGPU', '--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
        },
      },
    },
  ],
});
