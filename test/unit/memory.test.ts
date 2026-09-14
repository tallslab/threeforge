import { describe, expect, it } from 'vitest';
import { BoxGeometry, CompressedTexture, CubeTexture, DataTexture, DirectionalLight, Mesh, MeshStandardMaterial, RGBAFormat, Scene, UnsignedByteType } from 'three';
import { estimateMemory, geometryBytes, textureBytes } from '../../src/ledger/memory.js';

describe('memory estimate', () => {
  it('sizes uncompressed, mipmapped, cube and compressed textures', () => {
    const flat = new DataTexture(new Uint8Array(4 * 16 * 16), 16, 16, RGBAFormat, UnsignedByteType);
    flat.generateMipmaps = false;
    expect(textureBytes(flat)).toBe(16 * 16 * 4);
    const mip = new DataTexture(new Uint8Array(4 * 16 * 16), 16, 16, RGBAFormat, UnsignedByteType);
    mip.generateMipmaps = true;
    expect(textureBytes(mip)).toBe(Math.round((16 * 16 * 4 * 4) / 3));
    const cube = new CubeTexture();
    cube.image = Array(6).fill({ width: 8, height: 8 });
    cube.generateMipmaps = false;
    expect(textureBytes(cube)).toBe(8 * 8 * 4 * 6);
    const compressed = new CompressedTexture([{ data: new Uint8Array(100), width: 8, height: 8 }, { data: new Uint8Array(25), width: 4, height: 4 }], 8, 8);
    expect(textureBytes(compressed)).toBe(125);
  });

  it('sizes geometries from attribute and index buffers', () => {
    const box = new BoxGeometry();
    const expected = Object.values(box.attributes).reduce((n, a) => n + a.array.byteLength, 0) + box.index!.array.byteLength;
    expect(geometryBytes(box)).toBe(expected);
  });

  it('sums unique textures and geometries once and adds shadow maps and the frame buffer', () => {
    const scene = new Scene();
    const map = new DataTexture(new Uint8Array(4 * 4 * 4), 4, 4, RGBAFormat, UnsignedByteType);
    map.generateMipmaps = false;
    const material = new MeshStandardMaterial({ map });
    const geometry = new BoxGeometry();
    scene.add(new Mesh(geometry, material), new Mesh(geometry, material));
    const sun = new DirectionalLight();
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    scene.add(sun);
    const m = estimateMemory(scene, { textures: 1, geometries: 1 }, [800, 600]);
    expect(m.textures).toEqual({ count: 1, bytes: 64 });
    expect(m.geometries).toEqual({ count: 1, bytes: geometryBytes(geometry) });
    expect(m.renderTargets).toEqual({ count: 2, bytes: 1024 * 1024 * 4 + 800 * 600 * 8 });
    expect(m.estimated).toBe(true);
    expect(m.unreferenced).toEqual({ geometries: 0, textures: 0 });
    expect(m.chunks).toEqual({ total: 0, resident: 0 });
    // The renderer holds 6 geometries and 9 textures; the scene reaches 1 and 1; three itself holds 1 geometry, 2 frame-buffer textures and 2 per shadow map.
    expect(estimateMemory(scene, { textures: 9, geometries: 6 }, [800, 600]).unreferenced).toEqual({ geometries: 4, textures: 4 });
  });
});
