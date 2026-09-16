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
  VSMShadowMap,
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
    const m = estimateMemory(scene, { textures: 1 + 2 + 2 + 1, geometries: 2 }, [800, 600]);
    expect(m.unreferenced).toEqual({ geometries: 0, textures: 1 });
    // Render targets agree with the allowance: the point light's built cube map and the frame buffer, not the idle light's.
    expect(m.renderTargets).toEqual({ count: 2, bytes: 512 * 512 * 4 * 6 + 800 * 600 * 8 });
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

  it('allows the two blur targets of each built non-point VSM map: on the shadow node for a plain map, read off an array map', () => {
    const { scene } = sceneWithMap();
    const sun = new DirectionalLight();
    sun.castShadow = true;
    allocateShadowMap(sun, 256);
    const point = new PointLight(); // VSM blurs no point-light map (ShadowNode.js ~383)
    point.castShadow = true;
    allocateShadowMap(point, 256);
    const idle = new DirectionalLight(); // never built: no blur targets either
    idle.castShadow = true;
    scene.add(sun, point, idle);
    // The map, the frame buffer, the sun's map and depth plus its two RG half-float blur targets (ShadowNode.js ~409-410,
    // colour only), the point light's cube map and depth.
    const info = { textures: 1 + 2 + 2 + 2 + 2, geometries: 2 };
    expect(estimateMemory(scene, info, [800, 600], { shadowMapType: VSMShadowMap }).unreferenced.textures).toBe(0);
    expect(estimateMemory(scene, info, [800, 600]).unreferenced.textures).toBe(2);
    // An array map keeps its blur targets on the map itself (ShadowNode.js ~389-403): counted from them, once.
    const { scene: arrayScene } = sceneWithMap();
    const tiles = new DirectionalLight();
    tiles.castShadow = true;
    const blur = { format: RGFormat, type: HalfFloatType, depthBuffer: false };
    Object.assign(allocateShadowMap(tiles, 256), { _vsmShadowMapVertical: new RenderTarget(256, 256, blur), _vsmShadowMapHorizontal: new RenderTarget(256, 256, blur) });
    arrayScene.add(tiles);
    expect(estimateMemory(arrayScene, { textures: 1 + 2 + 2 + 2, geometries: 2 }, [800, 600], { shadowMapType: VSMShadowMap }).unreferenced.textures).toBe(0);
  });

  it('counts the two blur targets of each built non-point VSM map in renderTargets, from the shadow node and from an array map', () => {
    const { scene } = sceneWithMap();
    const sun = new DirectionalLight();
    sun.castShadow = true;
    sun.shadow.mapSize.set(256, 256);
    allocateShadowMap(sun, 256);
    const point = new PointLight(); // VSM blurs no point-light map (ShadowNode.js ~383), so it gets no blur targets
    point.castShadow = true;
    point.shadow.mapSize.set(256, 256);
    allocateShadowMap(point, 256);
    scene.add(sun, point);
    const info = { textures: 1 + 2 + 2 + 2 + 2, geometries: 2 };
    const maps = 256 * 256 * 4 + 256 * 256 * 4 * 6;
    expect(estimateMemory(scene, info, [0, 0]).renderTargets, 'no VSM: the two maps only').toEqual({ count: 2, bytes: maps });
    // Plus the sun's two RG half-float blur targets (ShadowNode.js ~409-410): 2 channels x 2 bytes a texel.
    expect(estimateMemory(scene, info, [0, 0], { shadowMapType: VSMShadowMap }).renderTargets).toEqual({ count: 4, bytes: maps + 2 * 256 * 256 * 4 });
    // An array map carries its blur targets itself (ShadowNode.js ~389-403): counted from them, once.
    const { scene: arrayScene } = sceneWithMap();
    const tiles = new DirectionalLight();
    tiles.castShadow = true;
    tiles.shadow.mapSize.set(256, 256);
    const blur = { format: RGFormat, type: HalfFloatType, depthBuffer: false };
    Object.assign(allocateShadowMap(tiles, 256), { _vsmShadowMapVertical: new RenderTarget(256, 256, blur), _vsmShadowMapHorizontal: new RenderTarget(256, 256, blur) });
    arrayScene.add(tiles);
    const arrayInfo = { textures: 1 + 2 + 2 + 2, geometries: 2 };
    expect(estimateMemory(arrayScene, arrayInfo, [0, 0], { shadowMapType: VSMShadowMap }).renderTargets).toEqual({ count: 3, bytes: 256 * 256 * 4 + 2 * 256 * 256 * 4 });
  });

  it("sizes a point light's shadow target by its map width on every face, agreeing with lighting.shadowTexels", () => {
    const { scene } = sceneWithMap();
    const lamp = new PointLight();
    lamp.castShadow = true;
    lamp.shadow.mapSize.set(512, 128); // non-square: three allocates the cube target from the width alone
    allocateShadowMap(lamp, 512);
    scene.add(lamp);
    // three renders all six faces at 512 x 512 (PointShadowNode.js:227, :254), so the target is width x width x 6,
    // which is exactly the texel count `lighting.shadowTexels` reports for this light, at 4 bytes a texel.
    const texels = 512 * 512 * 6;
    expect(estimateMemory(scene, { textures: 1 + 2 + 2, geometries: 2 }, [0, 0]).renderTargets).toEqual({ count: 1, bytes: texels * 4 });
  });

  it('allows the textures the caller counts for the renderer itself (options.internalTextures)', () => {
    const { scene } = sceneWithMap();
    const info = { textures: 1 + 2 + 1, geometries: 2 };
    expect(estimateMemory(scene, info, [800, 600]).unreferenced.textures).toBe(1);
    expect(estimateMemory(scene, info, [800, 600], { internalTextures: 1 }).unreferenced.textures).toBe(0);
  });

  it('allows the geometries the renderer drew for itself (options.internalGeometries), once when a mesh also reaches one', () => {
    const { scene, geometry } = sceneWithMap();
    // Two of PMREM's LOD planes and a background sphere, three's own; the output quad is INTERNAL_GEOMETRIES.
    const planes = [new BoxGeometry(), new BoxGeometry()];
    const sphere = new BoxGeometry();
    const info = { textures: 1 + 2, geometries: 1 + 1 + 3 };
    expect(estimateMemory(scene, info, [0, 0]).unreferenced.geometries).toBe(3);
    expect(estimateMemory(scene, info, [0, 0], { internalGeometries: [...planes, sphere] }).unreferenced.geometries).toBe(0);
    // One listed that the scene reaches as well is one geometry: the allowance adds only the others.
    expect(estimateMemory(scene, info, [0, 0], { internalGeometries: [...planes, geometry] }).unreferenced.geometries).toBe(1);
  });

  it('allows the textures the renderer created for itself by identity (options.rendererTextures), once when the scene reaches one', () => {
    const { scene } = sceneWithMap();
    const pmrem = [new DataTexture(), new DataTexture()]; // the ping-pong and the cube-UV targets' textures
    const info = { textures: 1 + 2 + 2, geometries: 2 };
    expect(estimateMemory(scene, info, [0, 0]).unreferenced.textures).toBe(2);
    expect(estimateMemory(scene, info, [0, 0], { rendererTextures: pmrem }).unreferenced.textures).toBe(0);
    // The app's own pmrem.fromScene() output set as scene.environment is reachable: it is not allowed twice, so a texture
    // removed without dispose() beside it still counts (allowing it twice would hide that one).
    scene.environment = pmrem[1]!;
    expect(estimateMemory(scene, { ...info, textures: info.textures + 1 }, [0, 0], { rendererTextures: pmrem }).unreferenced.textures).toBe(1);
  });

  it("allows one morph texture per reachable geometry with morph attributes (three r186 Morph.js ~93, keyed by geometry)", () => {
    const { scene } = sceneWithMap();
    const morphed = new BoxGeometry();
    morphed.morphAttributes.position = [morphed.attributes.position!.clone()];
    const material = new MeshStandardMaterial();
    scene.add(new Mesh(morphed, material), new Mesh(morphed, material));
    const info = { textures: 1 + 2 + 1, geometries: 3 };
    expect(estimateMemory(scene, info, [0, 0]).unreferenced).toEqual({ geometries: 0, textures: 0 });
    expect(estimateMemory(scene, { ...info, textures: info.textures + 1 }, [0, 0]).unreferenced.textures).toBe(1);
  });

  it('counts a held render target\'s colour texture once when a material reaches it (options.renderTargets)', () => {
    const { scene } = sceneWithMap();
    const mirror = new RenderTarget(64, 64); // colour and depth
    scene.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial({ map: mirror.texture })));
    const info = { textures: 1 + 2 + 2, geometries: 3 };
    expect(estimateMemory(scene, info, [0, 0], { renderTargets: [mirror] }).unreferenced.textures).toBe(0);
    expect(estimateMemory(scene, { ...info, textures: info.textures + 1 }, [0, 0], { renderTargets: [mirror] }).unreferenced.textures).toBe(1);
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

  it("allows three's DFG_LUT while the attached renderer holds it, counted through info.createTexture and destroyTexture, which detach() restores", () => {
    const renderer = new FakeRenderer();
    const memory = Object.assign(renderer.info.memory, { textures: 0, geometries: 0 });
    const calls: unknown[] = [];
    // Info.createTexture and destroyTexture (renderers/common/Info.js ~230-252), which Textures calls for every texture it uploads and destroys.
    const info = Object.assign(renderer.info, {
      createTexture(this: unknown, texture: unknown) {
        calls.push(this, texture);
        memory.textures++;
      },
      destroyTexture(this: unknown, texture: unknown) {
        calls.push(this, texture);
        memory.textures--;
      },
    });
    const { createTexture, destroyTexture } = info;
    const ledger = new DrawCallLedger();
    ledger.attach(renderer as never);
    const { scene, camera } = sceneWithCamera();
    scene.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial({ map: new DataTexture(new Uint8Array(4), 1, 1) })));
    scene.updateMatrixWorld();
    renderer.render(scene, camera);
    Object.assign(memory, { textures: 1 + 2, geometries: 1 + 1 }); // the map, and the frame buffer's colour and depth
    // three r186 nodes/functions/BSDF/DFGLUT.js: a module-private 16 x 16 RG half-float DataTexture named DFG_LUT.
    const lut = new DataTexture(new Uint16Array(16 * 16 * 2), 16, 16, RGFormat, HalfFloatType);
    lut.name = 'DFG_LUT';
    info.createTexture(lut);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe(info);
    expect(calls[1]).toBe(lut);
    expect(ledger.measureMemory().unreferenced).toEqual({ geometries: 0, textures: 0 });
    info.createTexture(new DataTexture(new Uint8Array(4), 1, 1)); // removed without dispose(): not the LUT
    expect(ledger.measureMemory().unreferenced.textures).toBe(1);
    info.destroyTexture(lut); // no longer held: nothing is allowed for it
    expect(calls[4]).toBe(info);
    expect(calls[5]).toBe(lut);
    expect(ledger.measureMemory().unreferenced.textures).toBe(1);
    ledger.detach();
    expect(info.createTexture).toBe(createTexture);
    expect(info.destroyTexture).toBe(destroyTexture);
  });

  it("allows three's PMREM planes and textures, the background sphere and the targets a pass draws into, and counts them again once gone", () => {
    const renderer = new FakeRenderer();
    const memory = Object.assign(renderer.info.memory, { textures: 0, geometries: 0 });
    const info = Object.assign(renderer.info, {
      createTexture(texture: unknown) {
        void texture;
        memory.textures++;
      },
      destroyTexture(texture: unknown) {
        void texture;
        memory.textures--;
      },
    });
    const ledger = new DrawCallLedger();
    ledger.attach(renderer as never);
    const { scene, camera } = sceneWithCamera();
    // three r186 Background.js ~131: the background sphere, drawn in the main pass as an object outside the scene.
    const sphere = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    sphere.name = 'Background.mesh';
    const map = new Mesh(new BoxGeometry(), new MeshBasicMaterial({ map: new DataTexture(new Uint8Array(4), 1, 1) }));
    map.onBeforeRender = (r) => void (r as unknown as FakeRenderer).renderObject(sphere, scene, camera, sphere.geometry, sphere.material, null, null, null, null);
    scene.add(map);
    scene.updateMatrixWorld();
    // PMREMGenerator (renderers/common/extras/PMREMGenerator.js): a LOD plane with an `outputDirection` attribute, rendered as
    // the root of its own render() into a target whose texture carries `isPMREMTexture` (~821, ~850-853).
    const plane = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    plane.geometry.setAttribute('outputDirection', plane.geometry.attributes.position!.clone());
    const cubeUv = new RenderTarget(48, 64, { depthBuffer: false });
    (cubeUv.texture as unknown as { isPMREMTexture: boolean }).isPMREMTexture = true;
    // A post-processing pass: the scene drawn into a colour and depth target every frame (PassNode.updateBefore).
    const passTarget = new RenderTarget(32, 32);
    const frame = (pmrem: boolean): void => {
      if (pmrem) {
        renderer.renderTarget = cubeUv;
        renderer.render(plane as never, camera);
      }
      renderer.renderTarget = passTarget;
      renderer.render(scene, camera);
      renderer.renderTarget = null;
      renderer.render(scene, camera);
    };
    info.createTexture(cubeUv.texture);
    frame(true);
    Object.assign(memory, {
      // the map, the frame buffer's colour and depth, the cube-UV texture, the pass target's colour and depth
      textures: 1 + 2 + 1 + 2,
      // the map's mesh, the output quad, the background sphere, the PMREM plane
      geometries: 1 + 1 + 1 + 1,
    });
    expect(ledger.measureMemory().unreferenced).toEqual({ geometries: 0, textures: 0 });
    // Gone from three: nothing is allowed for them any more, so the same counts read as unreferenced.
    info.destroyTexture(cubeUv.texture);
    cubeUv.dispose();
    plane.geometry.dispose();
    sphere.geometry.dispose();
    passTarget.dispose();
    Object.assign(memory, { textures: 1 + 2 + 1 + 2, geometries: 1 + 1 + 1 + 1 });
    expect(ledger.measureMemory().unreferenced).toEqual({ geometries: 2, textures: 3 });
    ledger.detach();
  });

  it('allows a render target a render drew into until it is disposed, and none that no render drew into', () => {
    const renderer = new FakeRenderer();
    const memory = Object.assign(renderer.info.memory, { textures: 0, geometries: 0 });
    const ledger = new DrawCallLedger();
    ledger.attach(renderer as never);
    const { scene, camera } = sceneWithCamera();
    scene.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial()));
    scene.updateMatrixWorld();
    // Drawn once and kept, as CubeMapNode keeps the cube it renders an equirect background into (nodes/utils/CubeMapNode.js ~115).
    const cube = new RenderTarget(16, 16, { depthBuffer: false });
    renderer.renderTarget = cube;
    renderer.render(scene, camera);
    renderer.renderTarget = null;
    // Created and uploaded, never drawn into (renderer.initRenderTarget): nothing tells it apart from a leak.
    const idle = new RenderTarget(16, 16, { depthBuffer: false });
    Object.assign(memory, { textures: 2 + 1 + 1, geometries: 1 + 1 }); // the frame buffer, the cube's colour, the idle target's colour
    for (let i = 0; i < 61; i++) renderer.render(scene, camera);
    expect(ledger.measureMemory().unreferenced.textures, 'the idle target').toBe(1);
    cube.dispose();
    expect(ledger.measureMemory().unreferenced.textures, 'the idle target and the disposed cube').toBe(2);
    void idle;
    ledger.detach();
  });

  it("allows the frame-buffer targets the renderer shows by identity, and none when it drew into none", () => {
    const { scene } = sceneWithMap();
    const info = { textures: 1 + 2, geometries: 2 };
    const frameBuffer = new RenderTarget(800, 600); // colour, and the depth texture three creates for its depth buffer
    expect(estimateMemory(scene, info, [800, 600], { frameBufferTargets: [frameBuffer] }).unreferenced.textures).toBe(0);
    // A RenderPipeline rendering the output itself: three draws into no frame-buffer target, so nothing is allowed for one.
    expect(estimateMemory(scene, info, [800, 600], { frameBufferTargets: [] }).unreferenced.textures).toBe(2);
    expect(estimateMemory(scene, info, [800, 600]).unreferenced.textures, 'without the map: the usual colour and depth').toBe(0);
  });

  it("allows three's DFG_LUT when info's texture hooks are prototype methods, and detach() makes the prototype's own visible again", () => {
    // three's Info (renderers/common/Info.js ~230-252) defines createTexture and destroyTexture on its prototype, not
    // as own properties. attach() adds own wrappers, which shadow them, and detach() removes those with `delete`, which
    // is the only reason the prototype's methods come back (DrawCallLedger.ts ~289-292). The test above installs own
    // properties and so exercises the other branch; this is the path three itself takes.
    const renderer = new FakeRenderer();
    const memory = Object.assign(renderer.info.memory, { textures: 0, geometries: 0 });
    const calls: Array<[string, unknown, unknown]> = [];
    const proto = {
      createTexture(this: unknown, texture: unknown): void {
        calls.push(['create', this, texture]);
        memory.textures++;
      },
      destroyTexture(this: unknown, texture: unknown): void {
        calls.push(['destroy', this, texture]);
        memory.textures--;
      },
    };
    Object.setPrototypeOf(renderer.info, proto);
    const info = renderer.info as typeof renderer.info & typeof proto;
    const owns = (key: string): boolean => Object.prototype.hasOwnProperty.call(info, key);
    expect([owns('createTexture'), owns('destroyTexture')], 'the hooks start on the prototype').toEqual([false, false]);

    const ledger = new DrawCallLedger();
    ledger.attach(renderer as never);
    expect([owns('createTexture'), owns('destroyTexture')], 'attach() wraps them as own properties').toEqual([true, true]);
    expect(info.createTexture).not.toBe(proto.createTexture);

    const { scene, camera } = sceneWithCamera();
    scene.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial({ map: new DataTexture(new Uint8Array(4), 1, 1) })));
    scene.updateMatrixWorld();
    renderer.render(scene, camera);
    Object.assign(memory, { textures: 1 + 2, geometries: 1 + 1 }); // the map, and the frame buffer's colour and depth

    const lut = new DataTexture(new Uint16Array(16 * 16 * 2), 16, 16, RGFormat, HalfFloatType);
    lut.name = 'DFG_LUT';
    info.createTexture(lut);
    // three's own prototype method still ran, with `info` as its `this`, and the ledger counted the LUT as allowed.
    expect(calls).toEqual([['create', info, lut]]);
    expect(memory.textures).toBe(4);
    expect(ledger.measureMemory().unreferenced).toEqual({ geometries: 0, textures: 0 });
    // A texture that is not the LUT is not allowed, so the allowance is the name, not the hook being wrapped at all.
    info.createTexture(new DataTexture(new Uint8Array(4), 1, 1));
    expect(ledger.measureMemory().unreferenced.textures).toBe(1);
    info.destroyTexture(lut);
    expect(calls[2]).toEqual(['destroy', info, lut]);
    expect(memory.textures).toBe(4);
    expect(ledger.measureMemory().unreferenced.textures).toBe(1);

    ledger.detach();
    expect([owns('createTexture'), owns('destroyTexture')], 'detach() deletes the wrappers').toEqual([false, false]);
    expect(info.createTexture, "three's prototype method is visible again").toBe(proto.createTexture);
    expect(info.destroyTexture).toBe(proto.destroyTexture);
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
