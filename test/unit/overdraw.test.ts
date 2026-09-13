import { describe, expect, it } from 'vitest';
import { AdditiveBlending, DoubleSide, Scene, type Material, type MeshBasicMaterial } from 'three';
import { measureOverdraw } from '../../src/ledger/overdraw.js';
import { sceneWithCamera } from './helpers/fakeRenderer.js';

/** Records the override material and the opaque/transparent toggles per render; returns scripted pixel sums. */
function protocolRenderer(sums: number[]) {
  const calls: Array<{ override: string; opaque: boolean; transparent: boolean; target: unknown }> = [];
  let target: unknown = null;
  let reads = 0;
  return {
    calls,
    opaque: true,
    transparent: true,
    render(scene: Scene) {
      calls.push({ override: scene.overrideMaterial ? scene.overrideMaterial.type : 'none', opaque: this.opaque, transparent: this.transparent, target });
    },
    setRenderTarget(t: unknown) {
      target = t;
    },
    getRenderTarget() {
      return target;
    },
    getDrawingBufferSize(v: { x: number; y: number }) {
      v.x = 800;
      v.y = 600;
      return v;
    },
    async readRenderTargetPixelsAsync(t: { width: number; height: number }) {
      const n = t.width * t.height;
      const px = new Float32Array(n * 4);
      for (let k = 0; k < n; k++) px[k * 4] = sums[reads] ?? 0;
      reads++;
      return px;
    },
  };
}

describe('measureOverdraw', () => {
  it('renders opaque then transparent with a count material into a 1/8 target and averages the red channel', async () => {
    const { scene, camera } = sceneWithCamera();
    const renderer = protocolRenderer([1.5, 0.75]);
    const result = await measureOverdraw(renderer as never, scene, camera);
    expect(result).toEqual({ opaque: 1.5, transparent: 0.75 });
    expect(renderer.calls.map((c) => [c.override, c.opaque, c.transparent])).toEqual([
      ['MeshBasicMaterial', true, false],
      ['MeshBasicMaterial', false, true],
    ]);
    const target = renderer.calls[0]!.target as { width: number; height: number };
    expect([target.width, target.height]).toEqual([128, 96]); // 800x600 / 8 rounded up to 32-texel rows (no read-back padding)
    expect(scene.overrideMaterial).toBeNull();
    expect(renderer.opaque && renderer.transparent).toBe(true);
    expect(renderer.getRenderTarget()).toBeNull();
  });

  it('decodes raw half-float read-backs (0x3C00 is 1.0)', async () => {
    const { scene, camera } = sceneWithCamera();
    const renderer = protocolRenderer([]);
    renderer.readRenderTargetPixelsAsync = async (t: { width: number; height: number }) => {
      const px = new Uint16Array(t.width * t.height * 4);
      for (let k = 0; k < t.width * t.height; k++) px[k * 4] = k % 2 === 0 ? 0x3c00 : 0x4000; // 1.0 and 2.0 alternating
      return px;
    };
    const result = await measureOverdraw(renderer as never, scene, camera);
    expect(result.opaque).toBeCloseTo(1.5, 6);
  });

  it('uses a count material that adds one per fragment on every face without depth', async () => {
    const { scene, camera } = sceneWithCamera();
    const renderer = protocolRenderer([0, 0]);
    let material: Material | null = null;
    renderer.render = (s: Scene) => {
      material = s.overrideMaterial;
    };
    await measureOverdraw(renderer as never, scene, camera);
    const m = material! as MeshBasicMaterial;
    expect([m.blending, m.depthTest, m.depthWrite, m.side, m.transparent, m.color.getHex()]).toEqual([AdditiveBlending, false, false, DoubleSide, true, 0xff0000]);
  });
});
