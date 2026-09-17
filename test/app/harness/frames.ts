import { Frustum, Matrix4, type Mesh, type PerspectiveCamera, type Scene } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import type { DrawCallLedger } from 'threeforge';

export type BackendName = 'webgl2' | 'webgpu';

export interface RenderOnceResult {
  backend: BackendName;
  multiDraw: boolean;
  /**
   * The backend's own count for that render, kept for report lines and the spike. CONTRIBUTING.md rule 5 says not to
   * assert on it: it is backend-dependent (N per BatchedMesh on WebGPU, 1 with multi-draw on WebGL2).
   */
  drawCalls: number;
  /** `ledger.frame().totals` for that render: the scene's own submissions, the renderer's included and excluded. */
  sceneSubmissions: number;
  submissions: number;
  /** `byReason['renderer-internal'].submissions`: three's output colour-transform quad and anything like it. */
  rendererInternal: number;
  /** `reportedDrawCalls - gpuDraws`. Non-zero means the ledger did not account for everything the backend issued. */
  unattributed: number;
}

export interface FrameProbes {
  renderOnce(): RenderOnceResult;
  /** Meshes of `target` whose bounding sphere intersects `cam`'s frustum (the test the renderer applies). */
  countVisible(target: Scene, cam: PerspectiveCamera): number;
  /** `countVisible` for the harness scene and camera. */
  visibleMeshes(): number;
}

export function createFrameProbes(h: {
  renderer: WebGPURenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  ledger: DrawCallLedger;
  backend: BackendName;
  multiDraw: boolean;
}): FrameProbes {
  const { renderer, scene, camera, ledger } = h;
  const frustum = new Frustum();
  const projScreen = new Matrix4();
  const countVisible = (target: Scene, cam: PerspectiveCamera): number => {
    target.updateMatrixWorld(true);
    cam.updateMatrixWorld(true);
    projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreen, renderer.coordinateSystem);
    let n = 0;
    target.traverse((o) => {
      if ((o as Mesh).isMesh && o.visible && (!o.frustumCulled || frustum.intersectsObject(o))) n++;
    });
    return n;
  };
  return {
    renderOnce() {
      // Delta inside one synchronous render() call: immune to info.autoReset running on three's own rAF.
      const before = renderer.info.render.drawCalls;
      renderer.render(scene, camera);
      const snapshot = ledger.frame();
      return {
        backend: h.backend,
        multiDraw: h.multiDraw,
        drawCalls: renderer.info.render.drawCalls - before,
        sceneSubmissions: snapshot.totals.sceneSubmissions,
        submissions: snapshot.totals.submissions,
        rendererInternal: snapshot.byReason['renderer-internal']?.submissions ?? 0,
        unattributed: snapshot.totals.unattributed,
      };
    },
    countVisible,
    visibleMeshes: () => countVisible(scene, camera),
  };
}
