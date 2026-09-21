import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document } from '@gltf-transform/core';
import pngjs from 'pngjs';
import { describe, expect, it } from 'vitest';
import { EnvironmentError } from '../../src/cli/errors.js';
import type { Step } from '../../src/cli/pipeline.js';
import { applySteps, countsOf, createIO, loadDeps, requirementsOf, statsOf } from '../../src/cli/transform.js';

/** `n` quads, one colour-only material each, sharing identical vertex data (so dedup and palette both have work). */
function quads(n: number, { unwelded = false } = {}): Document {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene();
  for (let i = 0; i < n; i++) {
    const positions = unwelded
      ? [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0]
      : [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0];
    const pos = doc.createAccessor().setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buffer);
    const prim = doc
      .createPrimitive()
      .setAttribute('POSITION', pos)
      .setMaterial(doc.createMaterial(`m${i}`).setBaseColorFactor([i / n, 0.2, 0.5, 1]));
    if (!unwelded)
      prim.setIndices(
        doc
          .createAccessor()
          .setType('SCALAR')
          .setArray(new Uint16Array([0, 1, 2, 2, 1, 3]))
          .setBuffer(buffer),
      );
    scene.addChild(
      doc
        .createNode(`n${i}`)
        .setMesh(doc.createMesh(`mesh${i}`).addPrimitive(prim))
        .setTranslation([i * 2, 0, 0]),
    );
  }
  return doc;
}

const step = (name: Step['name'], options: Step['options'] = {}): Step => ({ name, options });
const log = () => {};

describe('countsOf and statsOf', () => {
  it('tally nodes, meshes, primitives, materials, textures, accessors, vertices and triangles', () => {
    const doc = quads(3);
    expect(countsOf(doc)).toEqual({
      nodes: 3,
      meshes: 3,
      primitives: 3,
      materials: 3,
      textures: 0,
      textureBytes: 0,
      accessors: 6,
      vertices: 12,
      triangles: 6,
    });
    expect(statsOf(doc, 1234)).toMatchObject({
      bytes: 1234,
      textureBytes: 0,
      animations: 0,
      skins: 0,
      morphTargets: 0,
      extensions: [],
    });
  });
});

describe('applySteps', () => {
  it('dedup shares accessors, palette merges colour-only materials, prune drops leftovers', async () => {
    const doc = quads(6);
    const deps = await loadDeps([], false);
    const reports = await applySteps(doc, [step('dedup'), step('palette', { min: 5 }), step('prune')], deps, log);
    expect(reports.map((r) => [r.name, r.applied])).toEqual([
      ['dedup', true],
      ['palette', true],
      ['prune', true],
    ]);
    expect(reports[0]!.before.accessors).toBe(12);
    expect(reports[0]!.after.accessors).toBe(2);
    expect(countsOf(doc)).toMatchObject({ materials: 1, textures: 1, meshes: 6 });
    expect(doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!.listSemantics()).toEqual(['POSITION', 'TEXCOORD_0']);
  });

  it('weld merges vertices, simplify cuts triangles, quantize and meshopt add extensions', async () => {
    const doc = quads(1, { unwelded: true });
    const deps = await loadDeps(
      [step('simplify', { ratio: 0.5, error: 0.001 }), step('meshopt', { level: 'medium' })],
      false,
    );
    const [weld] = await applySteps(doc, [step('weld')], deps, log);
    expect(weld!.before.vertices).toBe(6);
    expect(weld!.after.vertices).toBe(4);
    const big = new Document();
    const buffer = big.createBuffer();
    const n = 20;
    const pos: number[] = [];
    const idx: number[] = [];
    for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) pos.push(x, y, Math.sin(x) * 0.01);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const a = y * (n + 1) + x;
        idx.push(a, a + 1, a + n + 1, a + 1, a + n + 2, a + n + 1);
      }
    const prim = big
      .createPrimitive()
      .setAttribute('POSITION', big.createAccessor().setType('VEC3').setArray(new Float32Array(pos)).setBuffer(buffer))
      .setIndices(big.createAccessor().setType('SCALAR').setArray(new Uint32Array(idx)).setBuffer(buffer));
    big.createScene().addChild(big.createNode('grid').setMesh(big.createMesh('grid').addPrimitive(prim)));
    const [simplify] = await applySteps(big, [step('simplify', { ratio: 0.5, error: 0.001 })], deps, log);
    expect(simplify!.before.triangles).toBe(800);
    expect(simplify!.after.triangles).toBeLessThan(500);
    await applySteps(big, [step('quantize')], deps, log);
    expect(statsOf(big, 0).extensions).toContain('KHR_mesh_quantization');
    await applySteps(big, [step('meshopt', { level: 'medium' })], deps, log);
    expect(statsOf(big, 0).extensions).toContain('EXT_meshopt_compression');
    const io = await createIO(deps);
    const bytes = await io.writeBinary(big);
    expect(countsOf(await io.readBinary(bytes)).triangles).toBe(simplify!.after.triangles);
  });

  it('compresses and resizes textures with sharp, and reports the step as skipped without it', async () => {
    const doc = quads(1);
    const png = new pngjs.PNG({ width: 64, height: 64 });
    png.data.fill(200);
    const image = new Uint8Array(pngjs.PNG.sync.write(png));
    const texture = doc.createTexture('t').setImage(image).setMimeType('image/png');
    doc.getRoot().listMaterials()[0]!.setBaseColorTexture(texture);
    const with_ = await loadDeps([step('textures', { format: 'webp', size: 32, quality: 85 })], true);
    const [applied] = await applySteps(doc, [step('textures', { format: 'webp', size: 32, quality: 85 })], with_, log);
    expect(applied!.applied).toBe(true);
    expect(applied!.after.textureBytes).not.toBe(applied!.before.textureBytes);
    expect(doc.getRoot().listTextures()[0]!.getMimeType()).toBe('image/webp');
    expect(doc.getRoot().listTextures()[0]!.getSize()).toEqual([32, 32]);
    expect(statsOf(doc, 0).extensions).toContain('EXT_texture_webp');
    const [skipped] = await applySteps(
      quads(1),
      [step('textures', { format: 'webp', size: null, quality: 85 })],
      { ...with_, sharp: null },
      log,
    );
    expect(skipped!.applied).toBe(false);
    expect(skipped!.note).toContain('sharp');
  });
});

describe('the KTX2 texture step', () => {
  const ktx2 = step('textures', {
    format: 'ktx2',
    size: null,
    quality: 85,
    ktx2: { codec: 'auto', qlevel: 128, uastcQuality: 2, zstd: 18 },
  });
  const textured = () => {
    const doc = quads(1);
    const png = new pngjs.PNG({ width: 64, height: 64 });
    png.data.fill(200);
    const texture = doc
      .createTexture('t')
      .setImage(new Uint8Array(pngjs.PNG.sync.write(png)))
      .setMimeType('image/png');
    doc.getRoot().listMaterials()[0]!.setBaseColorTexture(texture);
    return doc;
  };

  it('without the encoder is an environment error naming where to get one', async () => {
    const before = process.env.FORGE_KTX;
    process.env.FORGE_KTX = join(tmpdir(), 'no-such-ktx');
    try {
      await expect(loadDeps([ktx2], true)).rejects.toThrow(EnvironmentError);
      await expect(loadDeps([ktx2], true)).rejects.toThrow(/no-such-ktx.*KTX-Software.*FORGE_KTX/s);
    } finally {
      if (before === undefined) delete process.env.FORGE_KTX;
      else process.env.FORGE_KTX = before;
    }
    // The same when a caller hands the step dependencies that have no encoder: nothing is encoded in its place.
    const doc = textured();
    const deps = { ...(await loadDeps([], false)), ktx: null };
    await expect(applySteps(doc, [ktx2], deps, log)).rejects.toThrow(EnvironmentError);
    expect(doc.getRoot().listTextures()[0]!.getMimeType()).toBe('image/png');
  });

  it('needs no sharp, encodes through the runner and reports what it did', async () => {
    const doc = textured();
    const fixture = readFileSync('test/fixtures/ktx2/colour-etc1s.ktx2');
    const deps = {
      ...(await loadDeps([], false)),
      sharp: null,
      ktx: async (argv: string[]) => {
        if (argv[0] === 'create') writeFileSync(argv.at(-1)!, fixture);
      },
    };
    const [report] = await applySteps(doc, [ktx2], deps, log);
    expect(report).toMatchObject({ applied: true, note: '1 encoded as KTX2 (1 ETC1S, 0 UASTC)' });
    expect(doc.getRoot().listTextures()[0]!.getMimeType()).toBe('image/ktx2');
    expect(statsOf(doc, 0).extensions).toContain('KHR_texture_basisu');
    expect(requirementsOf(statsOf(doc, 0).extensions)[0]).toMatchObject({ needs: 'KTX2Loader' });
  });
});

describe('requirementsOf', () => {
  it('names the loader piece each extension needs and marks built-in ones with null code', () => {
    const reqs = requirementsOf([
      'EXT_meshopt_compression',
      'KHR_mesh_quantization',
      'EXT_texture_webp',
      'KHR_texture_basisu',
      'KHR_draco_mesh_compression',
      'KHR_materials_transmission',
      'VENDOR_unknown',
    ]);
    expect(reqs.find((r) => r.extension === 'EXT_meshopt_compression')!.code).toContain('setMeshoptDecoder');
    const basisu = reqs.find((r) => r.extension === 'KHR_texture_basisu')!.code!;
    expect(basisu).toContain('KTX2Loader');
    // detectSupportAsync is deprecated since r181 (node_modules/three/examples/jsm/loaders/KTX2Loader.js): init the renderer, then detectSupport.
    expect(basisu).not.toContain('detectSupportAsync');
    expect(basisu).toMatch(/await renderer\.init\(\); ktx2\.detectSupport\(renderer\);/);
    expect(reqs.find((r) => r.extension === 'KHR_draco_mesh_compression')!.code).toContain('DRACOLoader');
    expect(reqs.find((r) => r.extension === 'KHR_mesh_quantization')!.code).toBeNull();
    expect(reqs.find((r) => r.extension === 'EXT_texture_webp')!.code).toBeNull();
    expect(reqs.find((r) => r.extension === 'KHR_materials_transmission')).toBeUndefined();
    expect(reqs.find((r) => r.extension === 'VENDOR_unknown')!.needs).toMatch(/not known/);
  });
});
