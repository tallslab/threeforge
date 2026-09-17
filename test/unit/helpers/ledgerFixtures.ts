import { BoxGeometry, type DirectionalLight, Mesh, MeshStandardMaterial, type PointLight, type SpotLight } from 'three';
import type { DrawCallLedger } from '../../../src/ledger/DrawCallLedger.js';
import { tag } from '../../../src/tags.js';

/** The unit cube the ledger tests draw. */
export const box = new BoxGeometry(1, 1, 1);

/** A shadow-casting light named `name`, with a square map of `size` texels when given. */
export function casting<T extends DirectionalLight | SpotLight | PointLight>(light: T, name: string, size?: number): T {
  light.name = name;
  light.castShadow = true;
  if (size !== undefined) light.shadow.mapSize.set(size, size);
  return light;
}

/** A static mesh named `name` that casts a shadow. */
export function caster(name: string): Mesh {
  const mesh = tag.static(new Mesh(box, new MeshStandardMaterial()));
  mesh.name = name;
  mesh.castShadow = true;
  return mesh;
}

/** name → reason of the frame's scene items in `pass` (renderer-internal work left out). */
export function reasonsIn(ledger: DrawCallLedger, pass = 'main'): Record<string, string> {
  return Object.fromEntries(
    (ledger.frame({ items: true }).items ?? [])
      .filter((i) => i.pass === pass && i.reason !== 'renderer-internal')
      .map((i) => [i.name, i.reason]),
  );
}
