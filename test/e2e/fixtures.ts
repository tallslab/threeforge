import { test as base, expect, type Page } from '@playwright/test';

export type BackendName = 'webgl2' | 'webgpu';

export interface ForgeOptions {
  backend: BackendName;
}

export interface ForgePage {
  page: Page;
  backend: BackendName;
  open(scene: string, query?: Record<string, string>): Promise<void>;
  /**
   * Whether screenshot assertions are safe here. Capturing the SwiftShader WebGPU canvas in headless Chromium
   * drops the WebGPU instance ("Device Lost"), after which the renderer draws nothing; the native adapter is fine.
   */
  pixelChecks: boolean;
}

export const test = base.extend<ForgeOptions & { forge: ForgePage }>({
  backend: ['webgl2', { option: true }],
  forge: async ({ page, backend }, use) => {
    const open = async (scene: string, query: Record<string, string> = {}) => {
      const q = new URLSearchParams({ scene, backend, ...query });
      await page.goto(`/?${q.toString()}`);
      await page.waitForFunction(() => window.__forge?.ready === true || typeof window.__forge?.error === 'string', undefined, { timeout: 60_000 });
      const error = await page.evaluate(() => window.__forge.error);
      if (error) throw new Error(`harness failed to start: ${error}`);
      const actual = await page.evaluate(() => window.__forge.backend);
      // WebGPU only exists in secure contexts, so the adapter check has to happen on the served page itself.
      if (backend === 'webgpu' && actual !== 'webgpu') test.skip(true, 'no WebGPU adapter in this browser');
      expect(actual, 'page fell back to a different backend').toBe(backend);
    };
    const webgpuAdapter = process.env.FORGE_WEBGPU ?? (process.platform === 'linux' ? 'swiftshader' : 'native');
    await use({ page, backend, open, pixelChecks: backend !== 'webgpu' || webgpuAdapter === 'native' });
  },
});

export { expect };
