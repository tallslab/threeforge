/**
 * Names the GPU for a frame snapshot's `env.gpu` (and `tierInputFromNavigator`) from what three's backends expose:
 * on WebGPU three keeps only the device, and Chrome puts the adapter's info on it; on WebGL2 the unmasked renderer
 * string, when the browser grants `WEBGL_debug_renderer_info`. Falls back to the backend's name.
 */

interface AdapterInfo {
  description?: string;
  device?: string;
  vendor?: string;
  architecture?: string;
}

interface GpuBackend {
  isWebGPUBackend?: boolean;
  device?: { adapterInfo?: AdapterInfo };
  gl?: {
    getExtension(name: string): { UNMASKED_RENDERER_WEBGL: number } | null;
    getParameter(pname: number): unknown;
  };
}

/** Any renderer whose `backend` is three's WebGPU or WebGL backend; call after `renderer.init()`. */
export interface GpuRenderer {
  backend?: unknown;
}

export function gpuName(renderer: GpuRenderer): string {
  const b = (renderer.backend ?? {}) as GpuBackend;
  if (b.isWebGPUBackend) {
    const info = b.device?.adapterInfo;
    return (
      info?.description || info?.device || [info?.vendor, info?.architecture].filter(Boolean).join(' ') || 'webgpu'
    );
  }
  const ext = b.gl?.getExtension('WEBGL_debug_renderer_info');
  return ext && b.gl ? String(b.gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'webgl2';
}
