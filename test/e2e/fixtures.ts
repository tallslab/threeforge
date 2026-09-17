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
    const webgpuAdapter = process.env.FORGE_WEBGPU ?? (process.platform === 'linux' ? 'swiftshader' : 'native');
    const pixelChecks = backend !== 'webgpu' || webgpuAdapter === 'native';
    const open = async (scene: string, query: Record<string, string> = {}) => {
      const q = new URLSearchParams({ scene, backend, ...query });
      await page.goto(`/?${q.toString()}`);
      await page.waitForFunction(
        () => window.__forge?.ready === true || typeof window.__forge?.error === 'string',
        undefined,
        { timeout: 60_000 },
      );
      const error = await page.evaluate(() => window.__forge.error);
      if (error) throw new Error(`harness failed to start: ${error}`);
      const actual = await page.evaluate(() => window.__forge.backend);
      // WebGPU only exists in secure contexts, so the adapter check has to happen on the served page itself.
      if (backend === 'webgpu' && actual !== 'webgpu') {
        // A machine with no adapter skips, which keeps a local run useful. A job that exists to cover WebGPU must not
        // report green because every one of its tests skipped, so FORGE_REQUIRE_WEBGPU=1 turns the skip into a failure.
        if (process.env.FORGE_REQUIRE_WEBGPU === '1') {
          throw new Error(
            `FORGE_REQUIRE_WEBGPU=1, but this browser reported no WebGPU adapter (it ran as ${actual}; adapter setting: ${webgpuAdapter})`,
          );
        }
        test.skip(true, 'no WebGPU adapter in this browser');
      }
      expect(actual, 'page fell back to a different backend').toBe(backend);
    };
    // Pixel checks off means the specs below assert counts only, so a green run proves nothing about the picture.
    // Record that on every such test instead of leaving it implicit in the skip messages.
    if (!pixelChecks) {
      test.info().annotations.push({
        type: 'pixel-checks',
        description: `off for ${backend} on the ${webgpuAdapter} adapter: capturing that canvas drops the WebGPU device, so screenshot assertions are skipped`,
      });
    }
    await use({ page, backend, open, pixelChecks });
  },
});

export { expect };

/** Records a measurement on the test (visible in the JSON and HTML reports) instead of printing it. */
export function note(type: string, description: string): void {
  test.info().annotations.push({ type, description });
}

/** Compiles in the page, lets three frames settle, rescans the ledger and returns the report with the next frame. */
export async function compileAndSettle(forge: ForgePage) {
  return forge.page.evaluate(async () => {
    const f = window.__forge;
    const report = f.compile();
    for (let i = 0; i < 3; i++) await f.frameAsync();
    // Hints such as `batch-local-space` are gathered on the ledger's graph rescan, which runs every 60 frames: an app
    // sees them within a second of compiling, a four-frame test would not, so ask for the rescan.
    f.ledger.rescan();
    const frame = await f.frameAsync();
    return {
      /** Null when the World was made without `bake`. */
      bake: report.bake,
      after: report.after,
      hints: frame.hints.map((h) => ({ code: h.code, severity: h.severity })),
      submissions: frame.totals.sceneSubmissions,
      unattributed: frame.totals.unattributed,
    };
  });
}
