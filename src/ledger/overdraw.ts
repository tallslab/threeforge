import { AdditiveBlending, DataUtils, DoubleSide, HalfFloatType, MeshBasicMaterial, RenderTarget, Vector2, type Camera, type Scene } from 'three';

/** The slice of three's common Renderer the measurement drives. Structural so tests can fake it. */
export interface OverdrawRenderer {
  render(scene: Scene, camera: Camera): unknown;
  setRenderTarget(target: RenderTarget | null): void;
  getRenderTarget(): RenderTarget | null;
  readRenderTargetPixelsAsync(target: RenderTarget, x: number, y: number, width: number, height: number): Promise<ArrayLike<number>>;
  getDrawingBufferSize(target: Vector2): Vector2;
  /** Common Renderer flags gating the opaque and transparent render lists. */
  opaque: boolean;
  transparent: boolean;
}

export interface OverdrawOptions {
  /** Resolution of the count target relative to the drawing buffer (default 1/8). */
  scale?: number;
}

export interface OverdrawResult {
  /** Opaque fragments rasterised per pixel. */
  opaque: number;
  /** Transparent fragments rasterised per pixel. */
  transparent: number;
}

const _size = new Vector2();
let countMaterial: MeshBasicMaterial | null = null;
let target: RenderTarget | null = null;

/**
 * Fragments per pixel, measured rather than estimated: the scene is rendered twice into a small half-float
 * target with a material that adds 1 per fragment (no depth test, both faces), once for the opaque list and
 * once for the transparent list, then the target is read back and averaged. three copies alphaTest and alphaMap
 * from each object's material onto the override, so cutouts count only their visible texels. Costs two
 * low-resolution renders: call it on demand, not every frame.
 */
export async function measureOverdraw(renderer: OverdrawRenderer, scene: Scene, camera: Camera, options: OverdrawOptions = {}): Promise<OverdrawResult> {
  const scale = options.scale ?? 1 / 8;
  renderer.getDrawingBufferSize(_size);
  // Width in multiples of 32 texels: 8 bytes per half-float texel makes each row a multiple of 256 bytes, so the
  // WebGPU read-back has no row padding (three returns the padded buffer as-is).
  const width = Math.max(32, Math.ceil((_size.x * scale) / 32) * 32);
  const height = Math.max(1, Math.round((width * _size.y) / Math.max(1, _size.x)));
  if (!target || target.width !== width || target.height !== height) {
    target?.dispose();
    target = new RenderTarget(width, height, { type: HalfFloatType, depthBuffer: false, stencilBuffer: false });
  }
  countMaterial ??= new MeshBasicMaterial({ color: 0xff0000, blending: AdditiveBlending, depthTest: false, depthWrite: false, side: DoubleSide, transparent: true, fog: false });
  const previous = { override: scene.overrideMaterial, target: renderer.getRenderTarget(), opaque: renderer.opaque, transparent: renderer.transparent };
  const average = async (): Promise<number> => {
    const px = await renderer.readRenderTargetPixelsAsync(target!, 0, 0, width, height);
    // Half-float targets read back as raw 16-bit halves on both backends; bytes come back for RGBA8 targets.
    const decode = px instanceof Uint16Array ? (v: number) => DataUtils.fromHalfFloat(v) : px instanceof Uint8Array ? (v: number) => v / 255 : (v: number) => v;
    let sum = 0;
    for (let i = 0; i < width * height; i++) sum += decode(px[i * 4]!);
    return sum / (width * height);
  };
  try {
    scene.overrideMaterial = countMaterial;
    renderer.setRenderTarget(target);
    renderer.opaque = true;
    renderer.transparent = false;
    renderer.render(scene, camera);
    const opaque = await average();
    renderer.opaque = false;
    renderer.transparent = true;
    renderer.render(scene, camera);
    const transparent = await average();
    return { opaque, transparent };
  } finally {
    scene.overrideMaterial = previous.override;
    renderer.setRenderTarget(previous.target);
    renderer.opaque = previous.opaque;
    renderer.transparent = previous.transparent;
  }
}
