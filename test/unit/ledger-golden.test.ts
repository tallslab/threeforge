/**
 * Frozen ledger output (golden).
 *
 * Renders one deterministic scene for 3 frames and snapshots `DrawCallLedger.frame({ items: true })` to
 * `ledger-golden.snapshot.json`, stored next to this file. The scene touches every submission reason and pass
 * kind the ledger currently classifies (see the table in this file's describe block and in task-3-report.md), with
 * one exception: `static-unbatched`. That reason needs two statics that share a material, and every static here has
 * its own — the only shared material in the scene belongs to the two skinned meshes, `body` and `body-2` — so no
 * item in the snapshot carries it. `draw-call-ledger.test.ts` covers `static-unbatched` instead.
 * Task 26 (a hot-path rewrite of the ledger) must keep this file byte-identical; later tasks that change a
 * number on purpose update it and the diff is reviewed by a human — that review is the point of a golden file.
 *
 * To update after an intentional change to the ledger's output:
 *
 *   pnpm exec vitest run test/unit/ledger-golden.test.ts -u
 *
 * Every resulting diff to ledger-golden.snapshot.json must be reviewed before merge: it is the proof that the
 * change was the one you meant to make, not a regression. Do not run `-u` to make a failing run pass without
 * reading the diff first.
 *
 * Determinism:
 * - The ledger's `now` option is an injected counter (see `js-section.test.ts`), never `performance.now()`.
 * - Nothing in the snapshot is a `uuid` or an `Object3D.id` (the ledger never emits either).
 * - One exception needed correcting: `computeMaterialKeys()` (src/registry/materialKey.ts) folds a
 *   ShaderMaterial's own `material.uuid` into its `programHash`/`variantHash`, because it has no other way to
 *   key an unsupported material. Three.js assigns a fresh random `uuid` to every `Material` it constructs, so
 *   the golden's `shader` item would render a different programHash on every run. We pin that one material's
 *   `uuid` to a fixed string below (a test-file change, not a src/ change) so the hash — and everything that
 *   depends on it (byReason.unsupported-material, programs) — is stable and still fully present in the
 *   snapshot, not filtered out.
 */
import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  BufferGeometry,
  Camera,
  DirectionalLight,
  Float32BufferAttribute,
  Group,
  InstancedBufferGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Scene,
  ShaderMaterial,
  SkinnedMesh,
} from 'three';
import { DrawCallLedger } from '../../src/ledger/DrawCallLedger.js';
import { MaterialRegistry } from '../../src/registry/MaterialRegistry.js';
import { tag } from '../../src/tags.js';
import type { FrameSnapshot } from '../../src/ledger/snapshot.js';
import { FakeRenderer, sceneWithCamera, batchedOf } from './helpers/fakeRenderer.js';
import { buildRig } from './helpers/rig.js';

const box = new BoxGeometry(1, 1, 1);

/** The renderer surface the mirror/portal hooks below need; narrower than FakeRenderer's full type. */
interface RenderLike {
  renderTarget: object | null;
  render(scene: Object3D, camera: Camera): void;
}

/**
 * Builds the golden scene once. Covers, in one graph:
 * - named vs. unnamed siblings, a nested group (unnamed child -> path-based name), tags and an annotation
 * - batched (BatchedMesh), instanced with count 0 and count n, a sprite batch (InstancedBufferGeometry mesh)
 * - two skinned meshes sharing one Skeleton, a morph target, Points with a drawRange, a multi-material mesh
 * - a ShaderMaterial (unsupported), a shadow-casting light
 * - a nested render of the SAME scene into a named target ('mirror', reason unique-material, flag custom-hook)
 * - a second, distinct Scene rendered from within the first ('portal', reason unique-material, flag custom-hook)
 */
function buildScene() {
  const { scene, camera } = sceneWithCamera();
  scene.name = 'main-scene';

  const light = new DirectionalLight(0xffffff, 1);
  light.name = 'sun';
  light.castShadow = true;
  scene.add(light);

  // Named sibling, tagged static, the frame's only shadow caster.
  const crate = tag.static(new Mesh(box, new MeshStandardMaterial({ color: 0x8899aa })));
  crate.name = 'crate';
  crate.castShadow = true;

  // Unnamed sibling, untagged: exercises both path-based naming and the 'untagged' reason.
  const stray = new Mesh(box, new MeshStandardMaterial({ color: 0x223344 }));

  // Nested group with an unnamed dynamic child -> displayName 'assembly/Mesh[0]'.
  const assembly = new Group();
  assembly.name = 'assembly';
  const nestedChild = tag.dynamic(new Mesh(box, new MeshStandardMaterial({ color: 0x445566 })));
  assembly.add(nestedChild);

  // Annotated: the compiler's reason overrides the tag-derived one.
  const mirroredProp = tag.static(new Mesh(box, new MeshStandardMaterial({ color: 0x998877 })));
  mirroredProp.name = 'mirrored-prop';

  // Batched (3 instances of one geometry/material, via the fake's own helper).
  const batch = batchedOf(3, new MeshStandardMaterial({ color: 0x112233 }), box);

  // Instanced, count 0: still a submission (object hooks run), but 0 expected GPU draws.
  const instancedEmpty = new InstancedMesh(box, new MeshStandardMaterial({ color: 0x334455 }), 4);
  instancedEmpty.count = 0;
  instancedEmpty.name = 'debris-empty';

  // Instanced, count 5 of a maxInstanceCount 8.
  const instancedFive = new InstancedMesh(box, new MeshStandardMaterial({ color: 0x556677 }), 8);
  instancedFive.count = 5;
  instancedFive.name = 'debris';
  const m = new Matrix4();
  for (let i = 0; i < 5; i++) {
    m.makeTranslation(i * 2, 0, 0);
    instancedFive.setMatrixAt(i, m);
  }
  instancedFive.instanceMatrix.needsUpdate = true;

  // Sprite batch: a plain Mesh over an InstancedBufferGeometry, tagged the way World marks its sprite batches.
  const spriteGeometry = new InstancedBufferGeometry();
  const plane = new PlaneGeometry(1, 1);
  spriteGeometry.setIndex(plane.getIndex());
  spriteGeometry.setAttribute('position', plane.getAttribute('position'));
  spriteGeometry.instanceCount = 6;
  const spriteBatch = new Mesh(spriteGeometry, new MeshBasicMaterial({ color: 0xffddaa, transparent: true }));
  spriteBatch.name = 'forge:sprites:aa11bb22:0';
  spriteBatch.userData.forge = { kind: 'sprites' };

  // Two skinned meshes sharing one Skeleton: the ledger dedups bones per skeleton, not per submission.
  const rig = buildRig();
  const bodyTwo = new SkinnedMesh(rig.mesh.geometry, rig.mesh.material);
  bodyTwo.name = 'body-2';
  bodyTwo.bind(rig.mesh.skeleton);
  rig.root.add(bodyTwo);

  // Morph target.
  const morphGeometry = box.clone();
  morphGeometry.morphAttributes.position = [new Float32BufferAttribute(new Float32Array(morphGeometry.attributes.position!.count * 3), 3)];
  const morphMesh = tag.static(new Mesh(morphGeometry, new MeshStandardMaterial({ color: 0x998811 })));
  morphMesh.name = 'blob';
  morphMesh.morphTargetInfluences = [0.5];

  // Points with a drawRange narrower than the full buffer.
  const cloudGeometry = new BufferGeometry();
  cloudGeometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(300 * 3), 3));
  cloudGeometry.setDrawRange(0, 120);
  const dust = new Points(cloudGeometry, new PointsMaterial({ size: 2, color: 0xffffff }));
  dust.name = 'dust';

  // Multi-material mesh: 2 groups -> 2 submissions of the same object.
  const panelGeometry = box.clone();
  panelGeometry.clearGroups();
  panelGeometry.addGroup(0, 18, 0);
  panelGeometry.addGroup(18, 18, 1);
  const panel = new Mesh(panelGeometry, [new MeshStandardMaterial({ color: 0x224488 }), new MeshBasicMaterial({ color: 0x884422 })]);
  panel.name = 'panel';

  // ShaderMaterial: unsupported on WebGPURenderer. uuid pinned, see the file header.
  const shaderMaterial = new ShaderMaterial({
    vertexShader: 'void main() { gl_Position = vec4(position, 1.0); }',
    fragmentShader: 'void main() { gl_FragColor = vec4(1.0); }',
  });
  // @types/three types `uuid` readonly; three itself does not, and reassigning it is exactly the point here.
  (shaderMaterial as unknown as { uuid: string }).uuid = 'ffffffff-ffff-4fff-8fff-fffffffffffe';
  const shaderMesh = new Mesh(box, shaderMaterial);
  shaderMesh.name = 'fx-panel';

  // Second, distinct scene, reached only through the portal mesh below.
  const scene2 = new Scene();
  scene2.name = 'portal-scene';
  const farRoom = tag.static(new Mesh(box, new MeshStandardMaterial({ color: 0x00ffaa })));
  farRoom.name = 'far-room';
  scene2.add(farRoom);
  scene2.updateMatrixWorld(true);

  // Mirror: re-renders THIS scene into a named target ('nested:reflection'). Hides itself and the portal mesh
  // for the duration so the nested pass does not recurse or re-trigger the portal.
  const mirror = tag.static(new Mesh(box, new MeshStandardMaterial({ color: 0xaaaaaa })));
  mirror.name = 'mirror';
  // Portal: renders the distinct second scene ('scene:portal-scene').
  const portal = tag.static(new Mesh(box, new MeshStandardMaterial({ color: 0x4444ff })));
  portal.name = 'portal';
  mirror.onBeforeRender = ((rendererArg: unknown, _sceneArg: unknown, cameraArg: unknown) => {
    const renderer = rendererArg as RenderLike;
    mirror.visible = false;
    portal.visible = false;
    const previousTarget = renderer.renderTarget;
    renderer.renderTarget = { name: 'reflection' };
    renderer.render(scene, cameraArg as Camera);
    renderer.renderTarget = previousTarget;
    mirror.visible = true;
    portal.visible = true;
  }) as Object3D['onBeforeRender'];
  portal.onBeforeRender = ((rendererArg: unknown, _sceneArg: unknown, cameraArg: unknown) => {
    const renderer = rendererArg as RenderLike;
    renderer.render(scene2, cameraArg as Camera);
  }) as Object3D['onBeforeRender'];

  scene.add(crate, stray, assembly, mirroredProp, batch, instancedEmpty, instancedFive, spriteBatch, rig.root, morphMesh, dust, panel, shaderMesh, mirror, portal);
  scene.updateMatrixWorld(true);

  return { scene, camera, light, mirroredProp };
}

describe('DrawCallLedger golden output', () => {
  it('renders a scene covering every reason, pass kind and section for 3 frames with a stable snapshot', async () => {
    let t = 0;
    const registry = new MaterialRegistry();
    const ledger = new DrawCallLedger({ registry, now: () => t });
    const { scene, camera, light, mirroredProp } = buildScene();
    const renderer = new FakeRenderer({ shadowLights: [light] });
    ledger.annotate(mirroredProp, 'excluded:mirrored');

    // render() takes a fixed 3 ms; matches the pattern in js-section.test.ts. This clock ticks only inside render(), so
    // the snapshot's `js.renderMs: 12` (4 renders x 3) and `js.ledgerMs: 0` are what the injection dictates and cannot
    // fail on the renderMs/ledgerMs split (independent review M7). That split is covered by the two clock tests in
    // js-section.test.ts: one charges the ledger's filing time through rescan(), the other on every frame.
    const originalRender = renderer.render.bind(renderer);
    (renderer as { render: typeof originalRender }).render = (s, c) => {
      t += 3;
      return originalRender(s, c);
    };
    ledger.attach(renderer as never);

    const frames: FrameSnapshot[] = [];
    for (let i = 0; i < 3; i++) {
      renderer.render(scene, camera);
      frames.push(ledger.frame({ items: true }));
      t += 13; // frames start 16 ms apart (3 ms render + 13 ms idle), like js-section.test.ts
    }

    // Stability across repeated frames of an unchanging scene: everything but the injected clock is identical.
    for (const key of ['sceneSubmissions', 'gpuDraws', 'reportedDrawCalls', 'triangles', 'instances', 'instancesDrawn'] as const) {
      expect(frames[1]!.totals[key]).toBe(frames[0]!.totals[key]);
      expect(frames[2]!.totals[key]).toBe(frames[0]!.totals[key]);
    }
    expect(frames[1]!.byReason).toEqual(frames[0]!.byReason);
    expect(frames[2]!.byReason).toEqual(frames[0]!.byReason);
    expect(frames[1]!.passes.map((p) => p.id).sort()).toEqual(frames[0]!.passes.map((p) => p.id).sort());

    // Every scene element reaches the ledger under the reason/pass the brief calls for. `crate`, `mirror`, `portal`
    // and everything not hidden by the mirror hook also appear again under 'nested:reflection' (a mirror reflects
    // the whole scene); the assertions below key on (name, pass) so that duplication does not hide a wrong reason.
    const lastItems = frames[2]!.items!;
    const item = (name: string, pass: string) => lastItems.find((i) => i.name === name && i.pass === pass);
    expect(item('crate', 'main')).toMatchObject({ reason: 'unique-material', flags: expect.arrayContaining(['shadow-caster']) });
    expect(item('crate', 'shadow:sun')).toMatchObject({ reason: 'unique-material' }); // the frame's only shadow caster
    expect(item('Mesh[2]', 'main')).toMatchObject({ reason: 'untagged' }); // unnamed sibling: scene.children[2] (after light, crate)
    expect(item('assembly/Mesh[0]', 'main')).toMatchObject({ reason: 'dynamic' }); // nested group, unnamed child
    expect(item('mirrored-prop', 'main')).toMatchObject({ reason: 'excluded:mirrored' });
    expect(item('batch-3', 'main')).toMatchObject({ reason: 'batched', kind: 'batched', instances: 3 });
    expect(item('debris-empty', 'main')).toMatchObject({ reason: 'instanced', instances: 0, expectedGpuDraws: 0 });
    expect(item('debris', 'main')).toMatchObject({ reason: 'instanced', instances: 5, instancesDrawn: 5 });
    expect(item('forge:sprites:aa11bb22:0', 'main')).toMatchObject({ reason: 'sprite-batch', instances: 6 });
    const bodies = lastItems.filter((i) => i.pass === 'main' && (i.name === 'body' || i.name === 'body-2'));
    expect(bodies).toHaveLength(2);
    expect(bodies.every((b) => b.reason === 'skinned' && b.skeleton === bodies[0]!.skeleton)).toBe(true); // shared skeleton
    expect(item('blob', 'main')).toMatchObject({ reason: 'morph', morphTargets: 1 });
    expect(item('dust', 'main')).toMatchObject({ reason: 'points', vertices: 120 }); // drawRange caps vertices at 120
    const panelItems = lastItems.filter((i) => i.pass === 'main' && i.name === 'panel');
    expect(panelItems).toHaveLength(2);
    expect(panelItems.every((p) => p.reason === 'multi-material-group')).toBe(true);
    expect(item('fx-panel', 'main')).toMatchObject({ reason: 'unsupported-material' });
    expect(item('mirror', 'main')).toMatchObject({ reason: 'unique-material', flags: expect.arrayContaining(['custom-hook']) });
    expect(item('portal', 'main')).toMatchObject({ reason: 'unique-material', flags: expect.arrayContaining(['custom-hook']) });
    expect(item('far-room', 'scene:portal-scene')).toMatchObject({ reason: 'unique-material' });
    expect(frames[2]!.passes.map((p) => p.id).sort()).toEqual(['main', 'nested:reflection', 'scene:portal-scene', 'shadow:sun'].sort());
    expect(frames[2]!.byReason['renderer-internal']?.top).toContain('Output Color Transform');

    // Frame 1 and 2 in full, and frame 3 (with items) as the detailed record: capturing items on every frame
    // would repeat ~35 near-identical records 3 times over and bury the one part (js/timing) that actually
    // changes frame to frame, so only the last frame carries `items`; frames 1-2 carry every other section,
    // which is enough to prove they match frame 3 wherever nothing should have changed.
    const golden = {
      frame1: { ...frames[0]!, items: undefined },
      frame2: { ...frames[1]!, items: undefined },
      frame3: frames[2],
    };
    await expect(JSON.stringify(golden, null, 2)).toMatchFileSnapshot('./ledger-golden.snapshot.json');
  });
});
