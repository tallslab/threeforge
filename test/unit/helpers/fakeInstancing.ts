/**
 * The fake renderer's model of how three r186 gets an InstancedMesh's matrices and colours to the GPU
 * (`nodes/accessors/Instance.js`, `Geometries.updateAttribute`, `Bindings.updateForRender`): a uniform buffer per
 * render object up to `uniformBufferLimit` bytes, one vertex buffer shared by every render object above it, and the
 * upload timing of each. Read by `FakeDraw.instanceRows` and `instanceColorRows` with `record`.
 */
import type { BufferAttribute, Material, Object3D } from 'three';

export type Instanced = Object3D & {
  isInstancedMesh?: boolean;
  count: number;
  instanceMatrix: BufferAttribute;
  instanceColor: BufferAttribute | null;
};

/** How to read the matrix rows and colour rows a draw binds, at draw time (WebGL) or when its render() call ends (WebGPU). */
export interface InstanceReads {
  rows: () => Float32Array;
  colors: (() => Float32Array) | null;
}

/** A RenderObject of an InstancedMesh with its NodeBuilderState (three keys both by object, material and render context). */
export interface InstanceRenderObject {
  /** `instanceMatrix.version` at the last refresh (NodeMaterialObserver). */
  version: number;
  /** `instanceColor.version` at the last refresh, null without colours. */
  colorVersion: number | null;
  /** frameId when its OnBeforeFrameUpdate event last ran. */
  frame: number;
  /** The uniform buffer of the uniform path. */
  buffer: Float32Array | null;
  /** Whether Geometries.updateAttribute has checked its attribute once (the first check is not keyed by the render call). */
  checked: boolean;
}

/** Instance.js's InstancedInterleavedBuffer over `instanceMatrix` (or its InstancedBufferAttribute over `instanceColor`), and its GPU buffer. */
export interface InstanceVertexBuffer {
  version: number;
  ranges: { start: number; count: number }[];
  /** The version uploaded last; -1 before the buffer exists. */
  uploaded: number;
  /** `info.render.calls` of the last upload check. */
  call: number;
  data: Float32Array;
}

export class FakeInstanceBuffers {
  private readonly objects = new Map<string, InstanceRenderObject>();
  private readonly buffers = new WeakMap<BufferAttribute, InstanceVertexBuffer>();
  /** Bytes of instance matrices kept in a uniform buffer (`builder.getUniformBufferLimit()`). */
  private readonly uniformBufferLimit: number;

  constructor(uniformBufferLimit: number) {
    this.uniformBufferLimit = uniformBufferLimit;
  }

  /**
   * The render object of an InstancedMesh draw and whether it refreshes in full (NodeMaterialObserver: the first draw, or
   * `instanceMatrix.version` changed since its last refresh). three keys it by object, material and render context;
   * `context` is the renderer's part of the key (the pass's light, the call depth and the target's attachments): a shadow
   * map's override material is one per light (ShadowBaseNode `_shadowMaterialLib`), where the fake shares one.
   */
  renderObject(mesh: Instanced, material: Material, context: string): { state: InstanceRenderObject; full: boolean } {
    const key = `${mesh.uuid}|${material.uuid}|${context}`;
    let state = this.objects.get(key);
    const colorVersion = mesh.instanceColor === null ? null : mesh.instanceColor.version;
    const full =
      state === undefined || state.version !== mesh.instanceMatrix.version || state.colorVersion !== colorVersion;
    if (state === undefined) {
      state = { version: 0, colorVersion: null, frame: -1, buffer: null, checked: false };
      this.objects.set(key, state);
    }
    state.version = mesh.instanceMatrix.version;
    state.colorVersion = colorVersion;
    return { state, full };
  }

  /**
   * Instance.js's OnBeforeFrameUpdate event, which exists when the matrices use the vertex buffer or the mesh has
   * colours: once per frame per node builder it copies each shared buffer's version and update ranges from its source
   * attribute (replacing the ranges the buffer held) and clears the source's ranges.
   */
  sync(mesh: Instanced, state: InstanceRenderObject, frameId: number): void {
    const vertexPath = this.vertexPath(mesh);
    if ((!vertexPath && mesh.instanceColor === null) || state.frame === frameId) return;
    state.frame = frameId;
    for (const attribute of [vertexPath ? mesh.instanceMatrix : null, mesh.instanceColor]) {
      if (attribute === null) continue;
      const gpu = this.buffer(attribute);
      if (gpu.version === attribute.version) continue;
      gpu.ranges = attribute.updateRanges.map((range) => ({ start: range.start, count: range.count }));
      attribute.clearUpdateRanges();
      gpu.version = attribute.version;
    }
  }

  /**
   * Geometries.updateForRender and Bindings.updateForRender for the instance attributes; returns how to read the buffers
   * the draw binds. `calls` is `info.render.calls`, which every render() advances and nothing restores after a nested one.
   * - Matrices up to `uniformBufferLimit` bytes: a uniform buffer per render object (objectGroup bindings are cloned per
   *   render object, NodeBuilderState.createBindings), written from the array on a full refresh.
   * - Matrices above it: the InstancedInterleavedBuffer, one GPU buffer for every render object. On a full refresh
   *   Geometries.updateAttribute uploads when the GPU copy is older than the synced version: the ranges, or the whole
   *   array when there are none (WebGPUAttributeUtils.updateAttribute). After a render object's first check of its
   *   interleaved attribute, the shared buffer is checked at most once per render call.
   * - Divergence, on the strict side: three's Attributes.update keeps `data.version` per attribute object, and each render
   *   object builds its own interleaved attributes over the shared buffer, so another render object that refreshes
   *   later uploads again, with the ranges already consumed: the whole array (a second shadow light does). The fake keeps
   *   one uploaded version per buffer, so it never re-uploads rows that way and never hides a lost range.
   * - Colours: one InstancedBufferAttribute shared by every render object, checked at most once per render call.
   */
  upload(mesh: Instanced, state: InstanceRenderObject, full: boolean, calls: number): InstanceReads {
    const matrices = mesh.instanceMatrix;
    let rows: () => Float32Array;
    if (!this.vertexPath(mesh)) {
      if (full || state.buffer === null) state.buffer = (matrices.array as Float32Array).slice();
      rows = () => state.buffer!;
    } else {
      const gpu = this.buffer(matrices);
      if (full && (!state.checked || gpu.call !== calls)) {
        if (state.checked) gpu.call = calls;
        state.checked = true;
        this.uploadBuffer(gpu, matrices);
      }
      const data = gpu.data;
      rows = () => data;
    }
    let colors: (() => Float32Array) | null = null;
    if (mesh.instanceColor !== null) {
      const gpu = this.buffer(mesh.instanceColor);
      if (full && gpu.call !== calls) {
        gpu.call = calls;
        this.uploadBuffer(gpu, mesh.instanceColor);
      }
      const data = gpu.data;
      colors = () => data;
    }
    return { rows, colors };
  }

  /** Instance.js: matrices above `uniformBufferLimit` bytes go to the shared vertex buffer instead of a uniform buffer per render object. */
  private vertexPath(mesh: Instanced): boolean {
    return mesh.instanceMatrix.count * 64 > this.uniformBufferLimit;
  }

  private buffer(attribute: BufferAttribute): InstanceVertexBuffer {
    let gpu = this.buffers.get(attribute);
    if (gpu === undefined) {
      gpu = { version: 0, ranges: [], uploaded: -1, call: -1, data: new Float32Array(attribute.array.length) };
      this.buffers.set(attribute, gpu);
    }
    return gpu;
  }

  /** Attributes.update: creation uploads the whole array; later, a synced version newer than the upload writes the ranges, or everything without ranges. */
  private uploadBuffer(gpu: InstanceVertexBuffer, attribute: BufferAttribute): void {
    const array = attribute.array as Float32Array;
    if (gpu.uploaded < 0) {
      gpu.data.set(array);
      gpu.uploaded = gpu.version;
    } else if (gpu.uploaded < gpu.version) {
      if (gpu.ranges.length === 0) gpu.data.set(array);
      else
        for (const range of gpu.ranges)
          gpu.data.set(array.subarray(range.start, range.start + range.count), range.start);
      gpu.ranges = [];
      gpu.uploaded = gpu.version;
    }
  }
}
