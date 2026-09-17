import { describe, expect, it } from 'vitest';
import { gpuName } from '../../src/ledger/gpu.js';

/** A WebGL2 backend whose context answers `WEBGL_debug_renderer_info` with `unmasked`, or refuses the extension. */
function webgl2(unmasked: string | null) {
  const UNMASKED_RENDERER_WEBGL = 0x9246;
  return {
    backend: {
      isWebGPUBackend: false,
      gl: {
        getExtension: (name: string) =>
          name === 'WEBGL_debug_renderer_info' && unmasked !== null ? { UNMASKED_RENDERER_WEBGL } : null,
        getParameter: (p: number) => (p === UNMASKED_RENDERER_WEBGL ? unmasked : undefined),
      },
    },
  };
}

const webgpu = (adapterInfo?: Record<string, string>) => ({
  backend: { isWebGPUBackend: true, device: adapterInfo ? { adapterInfo } : {} },
});

describe('gpuName', () => {
  it('reads the unmasked renderer string on WebGL2', () => {
    expect(gpuName(webgl2('ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)'))).toBe(
      'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',
    );
  });

  it('falls back to the backend name when WebGL2 hides the renderer or has no context', () => {
    expect(gpuName(webgl2(null))).toBe('webgl2');
    expect(gpuName({ backend: { isWebGPUBackend: false } })).toBe('webgl2');
    expect(gpuName({})).toBe('webgl2');
  });

  it('prefers the adapter description, then the device, then vendor and architecture on WebGPU', () => {
    expect(gpuName(webgpu({ description: 'NVIDIA GeForce RTX 4080', device: '0x2704', vendor: 'nvidia' }))).toBe(
      'NVIDIA GeForce RTX 4080',
    );
    expect(gpuName(webgpu({ description: '', device: 'Apple M2', vendor: 'apple' }))).toBe('Apple M2');
    expect(gpuName(webgpu({ vendor: 'apple', architecture: 'metal-3' }))).toBe('apple metal-3');
    expect(gpuName(webgpu({ architecture: 'metal-3' }))).toBe('metal-3');
  });

  it('falls back to the backend name when WebGPU reports no adapter info', () => {
    expect(gpuName(webgpu({}))).toBe('webgpu');
    expect(gpuName(webgpu())).toBe('webgpu');
  });
});
