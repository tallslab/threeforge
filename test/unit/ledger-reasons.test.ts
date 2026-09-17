/** `src/ledger/reasons.ts` on its own: `flagsInto` writes a pooled record's flags in place; `reasonOf` resolves a submission's reason in one walk. */
import {
  BoxGeometry,
  Group,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Object3D,
  Scene,
} from 'three';
import { describe, expect, it } from 'vitest';
import { flagsInto, reasonOf } from '../../src/ledger/reasons.js';
import { tag } from '../../src/tags.js';

const box = new BoxGeometry(1, 1, 1);

describe('flagsInto', () => {
  /** An array that counts every write to it (elements and `length`). */
  const counted = (): { flags: string[]; writes: () => number } => {
    let writes = 0;
    const flags = new Proxy([] as string[], {
      set(target, key, value) {
        writes++;
        return Reflect.set(target, key, value);
      },
    });
    return { flags, writes: () => writes };
  };

  it("rewrites a pooled record's flags in place, writing nothing when they are unchanged: no length = 0 per submission per frame", () => {
    // V8 releases an array's backing store when its length is set to 0, so resetting a flagged record's array and pushing
    // its flags again allocated a new store for every flagged submission of every frame (~40 bytes per submission at the
    // ledger-overhead scenes, where a quarter of the meshes cast shadows and every shadow-pass record is flagged).
    const caster = new Mesh(box, new MeshStandardMaterial({ transparent: true }));
    caster.castShadow = true;
    const { flags, writes } = counted();
    flagsInto(caster, caster.material as Material, 1, flags as never);
    expect(flags).toEqual(['shadow-caster', 'transparent']);
    const first = writes();
    flagsInto(caster, caster.material as Material, 1, flags as never);
    expect(flags).toEqual(['shadow-caster', 'transparent']);
    expect(writes(), 'the same flags again').toBe(first);
    caster.castShadow = false;
    flagsInto(caster, caster.material as Material, 2, flags as never);
    expect(flags).toEqual(['double-sided-transparent', 'transparent']);
    (caster.material as Material).transparent = false;
    caster.renderOrder = 0;
    flagsInto(caster, caster.material as Material, 1, flags as never);
    expect(flags).toEqual([]);
  });
});

describe('reasonOf', () => {
  it('finds the root and the nearest tag in one walk: tags on the object, an ancestor, the root and above the root', () => {
    const material = new MeshStandardMaterial();
    const holder = new Group();
    const scene = new Scene();
    holder.add(scene);
    const group = new Group();
    const mesh = new Mesh(box, material);
    group.add(mesh);
    scene.add(group);
    const reason = (object: Object3D, root: Object3D = scene): string =>
      reasonOf(object, material, null, root, false, undefined);

    expect(reason(mesh)).toBe('untagged');
    tag.dynamic(holder);
    expect(reason(mesh)).toBe('dynamic'); // a tag above the root still counts, as effectiveTag() walks to the top
    tag.static(scene);
    expect(reason(mesh)).toBe('unique-material');
    tag.dynamic(group);
    expect(reason(mesh)).toBe('dynamic');
    tag.static(mesh);
    expect(reason(mesh)).toBe('unique-material');
    expect(reason(mesh, new Scene())).toBe('renderer-internal');
    expect(reason(mesh, group)).toBe('fullscreen-pass');
    const proxy = new Mesh(box, new MeshBasicMaterial({ colorWrite: false }));
    proxy.userData.forge = { kind: 'occlusion-proxy' };
    scene.add(proxy);
    expect(reason(proxy)).toBe('occlusion-proxy');
    expect(reasonOf(mesh, material, null, scene, true, undefined)).toBe('unsupported-material');
    expect(reasonOf(mesh, material, null, scene, false, 'excluded:mirrored')).toBe('excluded:mirrored'); // an annotation wins over tags
  });

  it('walks past a null userData on the drawn object and on an ancestor instead of throwing, and still finds a tag above them', () => {
    const material = new MeshStandardMaterial();
    const scene = new Scene();
    const group = new Group();
    const mesh = new Mesh(box, material);
    group.add(mesh);
    scene.add(group);
    // three fills `userData` on its own constructors, but app code and non-three loaders assign null, and
    // Object3D.copy propagates it to every clone. three renders such a scene without complaint, so both reads
    // reasonOf makes of it — the ancestor walk's tag, and the drawn object's own `forge` kind — must tolerate it.
    (group as { userData: unknown }).userData = null;
    (mesh as { userData: unknown }).userData = null;

    expect(reasonOf(mesh, material, null, scene, false, undefined)).toBe('untagged');
    // Tagged on the scene, not the mesh: tagging writes into `userData`, which is exactly what is null here.
    tag.static(scene);
    expect(reasonOf(mesh, material, null, scene, false, undefined)).toBe('unique-material');
    tag.dynamic(scene);
    expect(reasonOf(mesh, material, null, scene, false, undefined)).toBe('dynamic');
  });
});
