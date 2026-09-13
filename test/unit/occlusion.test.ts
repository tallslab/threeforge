import { describe, expect, it } from 'vitest';
import { BatchedMesh, BoxGeometry, InstancedMesh, Mesh, MeshStandardMaterial, Object3D, PerspectiveCamera, Scene } from 'three';
import { World } from '../../src/compiler/World.js';
import { DrawCallLedger } from '../../src/ledger/DrawCallLedger.js';
import { tag } from '../../src/tags.js';
import { FakeRenderer, sceneWithCamera } from './helpers/fakeRenderer.js';

const box = new BoxGeometry(1, 1, 1);
const solid = (color: number) => new MeshStandardMaterial({ color, roughness: 0.7, metalness: 0 });

/** Two chunks of statics far apart on x, so chunkSize splits them into two batches. */
function twoChunkScene() {
  const scene = new Scene();
  for (let i = 0; i < 4; i++) {
    const a = tag.static(new Mesh(box, solid(0x336699)));
    a.name = `left-${i}`;
    a.position.set(i * 2, 0, 0);
    const b = tag.static(new Mesh(box, solid(0x336699)));
    b.name = `right-${i}`;
    b.position.set(100 + i * 2, 0, 0);
    scene.add(a, b);
  }
  return scene;
}

function proxiesIn(scene: Scene): Mesh[] {
  return scene.children.filter((o): o is Mesh => (o as Mesh).isMesh && (o.userData.forge as { kind?: string } | undefined)?.kind === 'occlusion-proxy');
}

/** The fake renderer plus an occlusion answer per object, like renderer.isOccluded(). */
class OcclusionRenderer extends FakeRenderer {
  occluded = new Set<Object3D>();
  isOccluded(object: Object3D): boolean {
    return this.occluded.has(object);
  }
}

describe('World occlusion', () => {
  it('adds one invisible proxy per batch that carries the occlusion test', () => {
    const scene = twoChunkScene();
    const report = new World(scene, { chunkSize: 50, occlusion: true }).compile();
    const proxies = proxiesIn(scene);
    expect(proxies).toHaveLength(2);
    for (const proxy of proxies) {
      expect(proxy.occlusionTest).toBe(true);
      const material = proxy.material as MeshStandardMaterial;
      expect(material.colorWrite).toBe(false);
      expect(material.depthWrite).toBe(false);
      expect(proxy.name).toMatch(/^forge:occluder:forge:batch:/);
      expect(proxy.geometry.boundingBox).not.toBeNull();
    }
    expect(report.occlusion).toEqual({ proxies: 2 });
  });

  it('hides a batch whose proxy was reported occluded and shows it again when it is not', () => {
    const scene = twoChunkScene();
    const world = new World(scene, { chunkSize: 50, occlusion: true });
    world.compile();
    const renderer = new OcclusionRenderer();
    const { camera } = sceneWithCamera();
    const batches = scene.children.filter((o): o is BatchedMesh => (o as BatchedMesh).isBatchedMesh);
    const proxies = proxiesIn(scene);
    renderer.occluded.add(proxies[1]!);
    renderer.render(scene, camera); // results are read after the frame
    expect(batches[0]!.visible).toBe(true);
    expect(batches[1]!.visible).toBe(false);
    expect(proxies[1]!.visible).toBe(true); // the proxy keeps testing
    renderer.occluded.clear();
    renderer.render(scene, camera);
    expect(batches[1]!.visible).toBe(true);
  });

  it('is attributed by the ledger as occlusion-proxy and removes hidden batches from the count', () => {
    const scene = twoChunkScene();
    const world = new World(scene, { chunkSize: 50, occlusion: true });
    world.compile();
    const renderer = new OcclusionRenderer();
    const ledger = new DrawCallLedger();
    ledger.attach(renderer as never);
    const { camera } = sceneWithCamera();
    renderer.occluded.add(proxiesIn(scene)[0]!);
    renderer.render(scene, camera);
    renderer.render(scene, camera);
    const frame = ledger.frame();
    expect(frame.byReason['occlusion-proxy']?.submissions).toBe(2);
    expect(frame.byReason.batched?.submissions).toBe(1);
  });

  it('does nothing when the renderer has no isOccluded', () => {
    const scene = twoChunkScene();
    new World(scene, { chunkSize: 50, occlusion: true }).compile();
    const renderer = new FakeRenderer();
    const { camera } = sceneWithCamera();
    expect(() => renderer.render(scene, camera)).not.toThrow();
  });

  it('decompile removes proxies and restores visibility', () => {
    const scene = twoChunkScene();
    const world = new World(scene, { chunkSize: 50, occlusion: true });
    world.compile();
    const renderer = new OcclusionRenderer();
    const { camera } = sceneWithCamera();
    renderer.occluded.add(proxiesIn(scene)[0]!);
    renderer.render(scene, camera);
    world.decompile();
    expect(proxiesIn(scene)).toHaveLength(0);
    expect(scene.children.every((o) => o.visible)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(scene, 'onAfterRender')).toBe(false);
  });

  it('covers instanced groups too', () => {
    const scene = new Scene();
    for (let i = 0; i < 70; i++) {
      const m = tag.static(new Mesh(box, solid(0x2244ff)));
      m.position.set(i * 2, 0, 0);
      scene.add(m);
    }
    const world = new World(scene, { occlusion: true });
    world.compile();
    expect(world.instancedMeshes).toHaveLength(1);
    expect(proxiesIn(scene)).toHaveLength(1);
    const cam = new PerspectiveCamera();
    void cam;
    expect(scene.children.some((o) => (o as InstancedMesh).isInstancedMesh)).toBe(true);
  });
});
