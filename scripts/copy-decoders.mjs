// Copies three's Draco and Basis decoders into a page's public dir; run directly it fills the shipped harness page
// (cli-app/public/_decoders, gitignored). The twin of `copyDecoders` in src/cli/decoders.ts: the scripts are plain ESM
// with no build step, so they cannot import the .ts; keep the two in step.
import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function copyDecoders(dir, libs = 'node_modules/three/examples/jsm/libs') {
  mkdirSync(dir, { recursive: true });
  cpSync(join(libs, 'draco', 'gltf'), join(dir, 'draco'), { recursive: true });
  cpSync(join(libs, 'basis'), join(dir, 'basis'), { recursive: true });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  copyDecoders('cli-app/public/_decoders');
  console.log('decoders copied to cli-app/public/_decoders');
}
