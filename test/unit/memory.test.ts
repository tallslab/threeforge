import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  CompressedCubeTexture,
  CompressedTexture,
  CubeTexture,
  Data3DTexture,
  DataArrayTexture,
  DataTexture,
  DepthStencilFormat,
  DepthTexture,
  DirectionalLight,
  FloatType,
  HalfFloatType,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PointLight,
  RedFormat,
  RedIntegerFormat,
  RenderTarget,
  RGBAFormat,
  RGFormat,
  Scene,
  UnsignedByteType,
  UnsignedInt248Type,
  UnsignedIntType,
  VideoTexture,
  type Light,
} from 'three';
import { DrawCallLedger } from '../../src/ledger/DrawCallLedger.js';
import { estimateMemory, geometryBytes, textureBytes } from '../../src/ledger/memory.js';
import { disposeOverdraw, measureOverdraw, overdrawTargetOf } from '../../src/ledger/overdraw.js';
import { FakeRenderer, sceneWithCamera } from './helpers/fakeRenderer.js';

/** A shadow map as three r186 allocates it (ShadowNode.setupRenderTarget): a colour target with a depth texture. */
function allocateShadowMap(light: Light, size: number): RenderTarget {
  const target = new RenderTarget(size, size);
  target.depthTexture = new DepthTexture(size, size);
  (light as unknown as { shadow: { map: RenderTarget | null } }).shadow.map = target;
  return target;
}

/** A scene reaching one 4 x 4 texture and one geometry, drawn twice. */
function sceneWithMap(): { scene: Scene; geometry: BoxGeometry } {
  const scene = new Scene();
  const map = new DataTexture(new Uint8Array(4 * 4 * 4), 4, 4, RGBAFormat, UnsignedByteType);
  const material = new MeshStandardMaterial({ map });
  const geometry = new BoxGeometry();
  scene.add(new Mesh(geometry, material), new Mesh(geometry, material));
  return { scene, geometry };
}

describe('memory estimate', () => {
  it('sizes uncompressed, mipmapped, cube and compressed textures', () => {
    const flat = new DataTexture(new Uint8Array(4 * 16 * 16), 16, 16, RGBAFormat, UnsignedByteType);
    flat.generateMipmaps = false;
    expect(textureBytes(flat)).toBe(16 * 16 * 4);
    const mip = new DataTexture(new Uint8Array(4 * 16 * 16), 16, 16, RGBAFormat, UnsignedByteType);
    mip.generateMipmaps = true;
    expect(textureBytes(mip)).toBe(Math.round(16 * 16 * 4 * 1.333)); // Info._getTextureMemorySize's mip-chain factor
    const cube = new CubeTexture();
    cube.image = Array(6).fill({ width: 8, height: 8 });
    cube.generateMipmaps = false;
    expect(textureBytes(cube)).toBe(8 * 8 * 4 * 6);
    const compressed = new CompressedTexture([{ data: new Uint8Array(100), width: 8, height: 8 }, { data: new Uint8Array(25), width: 4, height: 4 }] as never, 8, 8);
    expect(textureBytes(compressed)).toBe(125);
  });

  it('takes channels from the format and bytes per channel from the type, as three r186 Info does (packed types included)', () => {
    const data = (format: number, type: number) => new DataTexture(null, 16, 16, format as never, type as never);
    expect(textureBytes(data(RedFormat, UnsignedByteType))).toBe(16 * 16); // R8
    expect(textureBytes(data(RGFormat, UnsignedByteType))).toBe(16 * 16 * 2); // RG8
    expect(textureBytes(data(RGBAFormat, FloatType))).toBe(16 * 16 * 16); // RGBA32F
    expect(textureBytes(data(RedFormat, HalfFloatType))).toBe(16 * 16 * 2); // R16F
    expect(textureBytes(data(RedIntegerFormat, UnsignedIntType))).toBe(16 * 16 * 4); // a BatchedMesh index texture
    const depthStencil = new DepthTexture(16, 16, UnsignedInt248Type);
    depthStencil.format = DepthStencilFormat;
    expect(textureBytes(depthStencil)).toBe(16 * 16 * 4); // packed 24/8
  });

  it('counts every layer of 3D and array textures', () => {
    expect(textureBytes(new Data3DTexture(null, 8, 8, 4))).toBe(8 * 8 * 4 * 4);
    const array = new DataArrayTexture(null, 8, 8, 3);
    array.format = RedFormat;
    expect(textureBytes(array)).toBe(8 * 8 * 3);
  });

  it('sums the mip levels three uploads from explicit mipmaps: every level of a 2D texture, the levels after the base of a cube', () => {
    // A 2D texture's mipmaps hold every level from the base (Textures.getMipLevels: mipmaps.length; the backends upload
    // mipmaps[i] at level i).
    const levels = new DataTexture(new Uint8Array(8 * 8 * 4), 8, 8, RGBAFormat, UnsignedByteType);
    levels.mipmaps = [8, 4, 2, 1].map((n) => ({ data: new Uint8Array(n * n * 4), width: n, height: n })) as never;
    expect(textureBytes(levels)).toBe((64 + 16 + 4 + 1) * 4);
    // A cube's hold the levels after the base (Textures.updateTexture adds a level for the base).
    const cube = new CubeTexture();
    cube.image = Array(6).fill({ width: 8, height: 8 });
    cube.generateMipmaps = false;
    cube.mipmaps = [4, 2].map((n) => ({ images: Array(6).fill({ width: n, height: n }) })) as never;
    expect(textureBytes(cube)).toBe((64 + 16 + 4) * 6 * 4);
  });

  it('sums the mip data of all six faces of a compressed cube', () => {
    const face = { width: 8, height: 8, mipmaps: [{ data: new Uint8Array(100), width: 8, height: 8 }, { data: new Uint8Array(25), width: 4, height: 4 }] };
    expect(textureBytes(new CompressedCubeTexture(Array(6).fill(face) as never))).toBe(125 * 6);
  });

  it("sizes a video texture by the video's frame, not the element's width and height attributes", () => {
    const video = { videoWidth: 64, videoHeight: 36, width: 0, height: 0 };
    expect(textureBytes(new VideoTexture(video as never))).toBe(64 * 36 * 4);
  });

  it('sizes geometries from attribute and index buffers', () => {
    const box = new BoxGeometry();
    const expected = Object.values(box.attributes).reduce((n, a) => n + a.array.byteLength, 0) + box.index!.array.byteLength;
    expect(geometryBytes(box)).toBe(expected);
  });

  it('sums unique textures and geometries once and adds shadow maps and the frame buffer', () => {
    const { scene, geometry } = sceneWithMap();
    const sun = new DirectionalLight();
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    scene.add(sun);
    allocateShadowMap(sun, 1024);
    const m = estimateMemory(scene, { textures: 1, geometries: 1 }, [800, 600]);
    expect(m.textures).toEqual({ count: 1, bytes: 64 });
    expect(m.geometries).toEqual({ count: 1, bytes: geometryBytes(geometry) });
    expect(m.renderTargets).toEqual({ count: 2, bytes: 1024 * 1024 * 4 + 800 * 600 * 8 });
    expect(m.estimated).toBe(true);
    expect(m.unreferenced).toEqual({ geometries: 0, textures: 0 });
    expect(m.chunks).toEqual({ total: 0, resident: 0 });
    // The renderer holds 6 geometries and 9 textures; the scene reaches 1 and 1; three itself holds 1 geometry, 2 frame-buffer textures and 2 for the shadow map.
    expect(estimateMemory(scene, { textures: 9, geometries: 6 }, [800, 600]).unreferenced).toEqual({ geometries: 4, textures: 4 });
  });

  it('one shadow light with a [0, 0] viewport reports no unreferenced textures: the allowance does not depend on the viewport', () => {
    const { scene } = sceneWithMap();
    const sun = new DirectionalLight();
    sun.castShadow = true;
    scene.add(sun);
    allocateShadowMap(sun, 512);
    // The map, the frame buffer's colour and depth, the shadow map's colour and depth.
    const m = estimateMemory(scene, { textures: 1 + 2 + 2, geometries: 1 + 1 }, [0, 0]);
    expect(m.unreferenced).toEqual({ geometries: 0, textures: 0 });
    expect(m.renderTargets).toEqual({ count: 1, bytes: 512 * 512 * 4 });
  });

  it('allows the shadow maps three allocated: none for a casting light whose map three never built, colour and depth for a point light', () => {
    const { scene } = sceneWithMap();
    const idle = new DirectionalLight(); // castShadow, but its ShadowNode never set up (shadowMap disabled, or never lit)
    idle.castShadow = true;
    const point = new PointLight();
    point.castShadow = true;
    scene.add(idle, point);
    allocateShadowMap(point, 256);
    // The map, the frame buffer (2), the point light's cube map and depth (2), and one texture removed without dispose().
    expect(estimateMemory(scene, { textures: 1 + 2 + 2 + 1, geometries: 2 }, [800, 600]).unreferenced).toEqual({ geometries: 0, textures: 1 });
  });

  it('allows the render targets passed in for the renderer (the overdraw count target), counting the textures three gives each', () => {
    const { scene } = sceneWithMap();
    const colourOnly = new RenderTarget(128, 96, { depthBuffer: false });
    const withDepth = new RenderTarget(16, 16);
    const info = { textures: 1 + 2 + 1 + 2, geometries: 2 };
    expect(estimateMemory(scene, info, [800, 600]).unreferenced.textures).toBe(3);
    expect(estimateMemory(scene, info, [800, 600], { renderTargets: [colourOnly, withDepth] }).unreferenced.textures).toBe(0);
    expect(estimateMemory(scene, info, [800, 600], { renderTargets: [null] }).unreferenced.textures).toBe(3);
  });

  it("memory.measured copies renderer.info.memory's counts and byte sizes, and is null without them", () => {
    const { scene } = sceneWithMap();
    const info = { textures: 9, geometries: 6, texturesSize: 4096, attributesSize: 3000, indexAttributesSize: 500, renderTargets: 2, total: 9000 };
    expect(estimateMemory(scene, info, [800, 600]).measured).toEqual({ textures: { count: 9, bytes: 4096 }, geometries: { count: 6, bytes: 3500 }, renderTargets: { count: 2 }, bytes: 9000 });
    expect(estimateMemory(scene, { textures: 9, geometries: 6 }, [800, 600]).measured).toBeNull();
  });
});

describe('the ledger memory section', () => {
  it('a ledger that measured overdraw reports no unreferenced textures on a scene with nothing else unreferenced', async () => {
    const renderer = new FakeRenderer();
    const ledger = new DrawCallLedger();
    ledger.attach(renderer as never);
    const { scene, camera } = sceneWithCamera();
    scene.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial({ map: new DataTexture(new Uint8Array(4), 1, 1) })));
    scene.updateMatrixWorld();
    renderer.render(scene, camera);
    await ledger.measureOverdraw(scene, camera);
    // What three r186 then holds: the map, the frame buffer's colour and depth, and the count target's colour texture
    // (created with depthBuffer: false, so Textures.updateRenderTarget gives it no depth texture).
    Object.assign(renderer.info.memory, { textures: 1 + 2 + 1, geometries: 1 + 1 });
    expect(ledger.measureMemory().unreferenced).toEqual({ geometries: 0, textures: 0 });
    ledger.detach();
  });

  it('overdrawTargetOf(renderer) is the count target measureOverdraw keeps for that renderer, until disposeOverdraw()', async () => {
    const renderer = new FakeRenderer();
    const other = new FakeRenderer();
    const { scene, camera } = sceneWithCamera();
    const targets: unknown[] = [];
    const setRenderTarget = renderer.setRenderTarget.bind(renderer);
    renderer.setRenderTarget = (target, ...rest) => {
      if (target) targets.push(target);
      setRenderTarget(target, ...rest);
    };
    expect(overdrawTargetOf(renderer)).toBeNull();
    await measureOverdraw(renderer as never, scene, camera);
    expect(overdrawTargetOf(renderer)).toBe(targets[0]);
    expect(overdrawTargetOf(other)).toBeNull();
    disposeOverdraw(renderer);
    expect(overdrawTargetOf(renderer)).toBeNull();
  });
});
