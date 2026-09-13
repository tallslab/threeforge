import { test as base, expect, type Page } from '@playwright/test';

export type BackendName = 'webgl2' | 'webgpu';

export interface ForgeOptions {
  backend: BackendName;
}

export interface ForgePage {
  page: Page;
  backend: BackendName;
  open(scene: string, query?: Record<string, string>): Promise<void>;
}

export const test = base.extend<ForgeOptions & { forge: ForgePage }>({
  backend: ['webgl2', { option: true }],
  forge: async ({ page, backend }, use) => {
    if (backend === 'webgpu') {
      await page.goto('about:blank');
      const hasAdapter = await page.evaluate(async () => {
        const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
        if (!gpu) return false;
        return (await gpu.requestAdapter()) !== null;
      });
      test.skip(!hasAdapter, 'no WebGPU adapter in this browser');
    }
    const open = async (scene: string, query: Record<string, string> = {}) => {
      const q = new URLSearchParams({ scene, backend, ...query });
      await page.goto(`/?${q.toString()}`);
      await page.waitForFunction(() => window.__forge?.ready === true, undefined, { timeout: 60_000 });
      const actual = await page.evaluate(() => window.__forge.backend);
      expect(actual, 'page fell back to a different backend').toBe(backend);
    };
    await use({ page, backend, open });
  },
});

export { expect };
