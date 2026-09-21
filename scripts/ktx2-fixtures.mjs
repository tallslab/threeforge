// node scripts/ktx2-fixtures.mjs: rebuilds test/fixtures/ktx2 from nothing. Four 64 x 64 PNGs are drawn here (sRGB
// colour with a hard edge, colour with an alpha ramp, a tangent-space normal map, a packed occlusion/roughness/metallic
// map), each is encoded to KTX2 as ETC1S and as UASTC with its mip chain, and three GLBs put them on two planes: the
// PNGs, the ETC1S files, the UASTC files. Needs KTX-Software's `ktx` (FORGE_KTX=/path/to/ktx, or on PATH); the tests
// that load the fixtures need nothing but the files. `drawImages` and `planesGlb` also build the larger source model
// of the encoding test.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';
import { KHRTextureBasisu } from '@gltf-transform/extensions';
import { PNG } from 'pngjs';

const OUT = 'test/fixtures/ktx2';
const DATA = new Set(['normal', 'orm']);
const byte = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255);

/** The four maps as PNG bytes, `size` pixels square. */
export function drawImages(size) {
  const draw = (pixel) => {
    const png = new PNG({ width: size, height: size });
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) png.data.set(pixel(x / (size - 1), y / (size - 1), x, y), (y * size + x) * 4);
    return PNG.sync.write(png);
  };
  const checker = (x, y, cells) => Math.floor((x * cells) / size) % 2 === Math.floor((y * cells) / size) % 2;
  return {
    // A smooth ramp on the left, flat blocks with hard edges on the right: what ETC1S blurs and what it keeps.
    colour: draw((u, v, x, y) =>
      x < size / 2 ? [byte(u * 2), byte(v), 40, 255] : checker(x, y, 8) ? [20, 60, 220, 255] : [240, 230, 60, 255],
    ),
    alpha: draw((u, v) => [230, byte(0.3 + 0.5 * v), 70, byte(u)]),
    // A dome: unit normals with z up, packed to 0..255 as glTF stores them.
    normal: draw((u, v) => {
      const [nx, ny] = [(u - 0.5) * 1.6, (0.5 - v) * 1.6];
      const nz = Math.sqrt(Math.max(0.05, 1 - nx * nx - ny * ny));
      const length = Math.hypot(nx, ny, nz);
      return [byte(nx / length / 2 + 0.5), byte(ny / length / 2 + 0.5), byte(nz / length / 2 + 0.5), 255];
    }),
    // glTF packs occlusion in R, roughness in G, metallic in B: three unrelated signals in one image.
    orm: draw((u, v, x, y) => [
      byte(0.4 + 0.6 * v),
      byte(Math.floor(u * 4) / 4 + 0.125),
      checker(x, y, 4) ? 255 : 0,
      255,
    ]),
  };
}

/**
 * A GLB of two unit planes side by side: `lit` (colour, normal, packed data) and `blended` (the alpha map).
 * `images[name]` is `{ bytes, mimeType }`.
 */
export async function planesGlb(images) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const ktx2 = Object.values(images).some((image) => image.mimeType === 'image/ktx2');
  if (ktx2) doc.createExtension(KHRTextureBasisu).setRequired(true);
  const texture = (name) => doc.createTexture(name).setImage(images[name].bytes).setMimeType(images[name].mimeType);
  const accessor = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const plane = (x) =>
    doc
      .createPrimitive()
      .setIndices(accessor('SCALAR', new Uint16Array([0, 1, 2, 2, 1, 3])))
      .setAttribute('POSITION', accessor('VEC3', new Float32Array([x, 1, 0, x, 0, 0, x + 1, 1, 0, x + 1, 0, 0])))
      .setAttribute('NORMAL', accessor('VEC3', new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1])))
      .setAttribute('TEXCOORD_0', accessor('VEC2', new Float32Array([0, 0, 0, 1, 1, 0, 1, 1])));
  const orm = texture('orm');
  const lit = doc
    .createMaterial('lit')
    .setBaseColorTexture(texture('colour'))
    .setNormalTexture(texture('normal'))
    .setOcclusionTexture(orm)
    .setMetallicRoughnessTexture(orm);
  const blended = doc
    .createMaterial('blended')
    .setBaseColorTexture(texture('alpha'))
    .setAlphaMode('BLEND')
    .setMetallicFactor(0);
  const scene = doc.createScene();
  scene.addChild(doc.createNode('lit').setMesh(doc.createMesh('lit').addPrimitive(plane(-1.05).setMaterial(lit))));
  scene.addChild(
    doc.createNode('blended').setMesh(doc.createMesh('blended').addPrimitive(plane(0.05).setMaterial(blended))),
  );
  return new NodeIO().registerExtensions([KHRTextureBasisu]).writeBinary(doc);
}

/** The `ktx create` command line of one fixture. Transfer function and primaries are assigned, never converted. */
function createArgs(name, codec) {
  const channels = name === 'alpha' ? 'R8G8B8A8' : 'R8G8B8';
  const colour = DATA.has(name)
    ? ['--format', `${channels}_UNORM`, '--assign-tf', 'linear', '--assign-primaries', 'none']
    : ['--format', `${channels}_SRGB`, '--assign-tf', 'srgb', '--assign-primaries', 'bt709'];
  const encode =
    codec === 'etc1s'
      ? ['--encode', 'basis-lz', '--qlevel', '128']
      : ['--encode', 'uastc', '--uastc-quality', '2', '--zstd', '18'];
  return [
    'create',
    ...colour,
    '--generate-mipmap',
    '--fail-on-color-conversions',
    '--threads',
    '1',
    '--testrun',
    ...encode,
  ];
}

async function main() {
  const ktx = process.env.FORGE_KTX ?? 'ktx';
  mkdirSync(OUT, { recursive: true });
  const commands = [];
  const names = [];
  for (const [name, png] of Object.entries(drawImages(64))) {
    names.push(name);
    writeFileSync(join(OUT, `${name}.png`), png);
    for (const codec of ['etc1s', 'uastc']) {
      const args = [...createArgs(name, codec), join(OUT, `${name}.png`), join(OUT, `${name}-${codec}.ktx2`)];
      execFileSync(ktx, args, { stdio: 'inherit' });
      execFileSync(ktx, ['validate', '--gltf-basisu', '--warnings-as-errors', join(OUT, `${name}-${codec}.ktx2`)], {
        stdio: 'inherit',
      });
      commands.push(`ktx ${args.join(' ')}`);
    }
  }
  for (const variant of ['png', 'etc1s', 'uastc']) {
    const file = (name) => (variant === 'png' ? `${name}.png` : `${name}-${variant}.ktx2`);
    const images = Object.fromEntries(
      names.map((name) => [
        name,
        { bytes: readFileSync(join(OUT, file(name))), mimeType: variant === 'png' ? 'image/png' : 'image/ktx2' },
      ]),
    );
    writeFileSync(join(OUT, `planes-${variant}.glb`), await planesGlb(images));
  }
  const version = execFileSync(ktx, ['--version'], { encoding: 'utf8' }).trim();
  writeFileSync(
    join(OUT, 'README.md'),
    `# KTX2 fixtures\n\nGenerated by \`node scripts/ktx2-fixtures.mjs\` with ${version}; do not edit by hand. The PNGs are drawn by the\nscript, 64 x 64. \`planes-<variant>.glb\` puts them on two planes: \`lit\` (colour, normal and the packed\nocclusion/roughness/metallic map) and \`blended\` (the alpha ramp).\n\n\`\`\`\n${commands.join('\n')}\n\`\`\`\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
