import { cpSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** `three/examples/jsm/libs` of the installed three, resolved from its main entry (`build/three.cjs`, two levels down). */
export function threeLibsDir(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('three')), '..', 'examples', 'jsm', 'libs');
}

/** Copies the Draco glTF decoder and the Basis transcoder into `<dir>/draco` and `<dir>/basis` for `createLoader`. */
export function copyDecoders(dir: string, libs: string = threeLibsDir()): { draco: string; basis: string } {
  const draco = join(dir, 'draco');
  const basis = join(dir, 'basis');
  mkdirSync(dir, { recursive: true });
  cpSync(join(libs, 'draco', 'gltf'), draco, { recursive: true });
  cpSync(join(libs, 'basis'), basis, { recursive: true });
  return { draco, basis };
}
