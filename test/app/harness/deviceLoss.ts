import type { WebGPURenderer } from 'three/webgpu';

export interface DeviceLossTiming {
  lostAt: number | null;
  /** three's `onDeviceLost` never fired: the loss was noticed by `deviceLost`'s wait, so it happened at or before `lostAt`. */
  lostAtIsUpperBound: boolean;
  compileStartedAt: number | null;
}

export interface DeviceLossTracker {
  /** The message of the WebGPU device loss three reported, or null; waits up to `waitMs` for a loss under way. */
  deviceLost(waitMs?: number): Promise<string | null>;
  /** When the loss was recorded, against threeforge's first `compile()` of the page. */
  deviceLostTiming(): DeviceLossTiming;
  /** Records the first `compile()` start. */
  markCompileStart(): void;
}

/**
 * Records a device loss (the SwiftShader adapter drops the device between test steps) before three logs it, and
 * when it happened relative to threeforge's first compile, so a spec can tell an environment loss from one
 * threeforge may have caused.
 */
export function trackDeviceLoss(renderer: WebGPURenderer): DeviceLossTracker {
  let message: string | null = null;
  let lostAt: number | null = null;
  let lostAtIsUpperBound = false;
  let compileStartedAt: number | null = null;
  const report = renderer.onDeviceLost;
  renderer.onDeviceLost = function (this: WebGPURenderer, info: Parameters<WebGPURenderer['onDeviceLost']>[0]) {
    message = (info as { message?: string }).message || 'device lost';
    if (lostAt === null || lostAtIsUpperBound) {
      lostAt = performance.now();
      lostAtIsUpperBound = false;
    }
    return report.call(this, info);
  };
  return {
    async deviceLost(waitMs = 250) {
      const lost = (renderer.backend as { device?: { lost?: Promise<{ message?: string }> } }).device?.lost;
      if (message === null && lost) {
        const info = await Promise.race([
          lost,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), waitMs)),
        ]);
        if (info && message === null) {
          message = info.message || 'device lost';
          lostAt = performance.now();
          lostAtIsUpperBound = true;
        }
      }
      return message;
    },
    deviceLostTiming: () => ({ lostAt, lostAtIsUpperBound, compileStartedAt }),
    markCompileStart() {
      compileStartedAt ??= performance.now();
    },
  };
}
