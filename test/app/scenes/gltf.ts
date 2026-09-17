import { AmbientLight, AnimationMixer, Box3, Color, DirectionalLight, type Mesh, Scene, Sphere, Vector3 } from 'three';
import { disposeLoader } from 'threeforge';
import { findAsset } from '../assets.js';
import { applyRoomEnvironment } from './environment.js';
import type { BenchBuilder } from './index.js';

/** Summary of the loaded asset (`scene=gltf&asset=<name>`). */
export interface GltfInfo {
  name: string;
  meshes: number;
  materials: number;
  vertices: number;
  triangles: number;
  animations: number;
  skinned: number;
  morph: number;
  instanced: number;
  linesPoints: number;
  radius: number;
  loadMs: number;
  clips: string[];
  bones: number;
}

/**
 * A named asset from the index, or any served file via `?url=<path under test/assets/files>`, framed by its bounding
 * sphere under the room environment; its clips play to a deterministic mid-animation pose.
 */
export const gltfScene: BenchBuilder = async ({ renderer, camera, params, loader: makeLoader, url }) => {
  const name = params.get('asset') ?? params.get('url') ?? '';
  const entry = params.has('url') ? params.get('url')!.replace(/^\//, '') : await findAsset(name);
  const loader = await makeLoader();
  const t0 = performance.now();
  const gltf = await loader.loadAsync(url(entry));
  const loadMs = performance.now() - t0;
  disposeLoader(loader);
  const scene = new Scene();
  scene.background = new Color(0x202830);
  scene.add(gltf.scene);
  applyRoomEnvironment(renderer, scene);
  const key = new DirectionalLight(0xffffff, 1.5);
  key.position.set(1, 2, 1.5);
  scene.add(new AmbientLight(0xffffff, 0.2), key);
  const clips = gltf.animations;
  if (clips.length > 0) {
    const mixer = new AnimationMixer(gltf.scene);
    for (const clip of clips) mixer.clipAction(clip).play();
    mixer.setTime(0.7);
  }
  scene.updateMatrixWorld(true);
  const sphere = new Box3().setFromObject(gltf.scene).getBoundingSphere(new Sphere());
  const radius = Math.max(sphere.radius, 1e-3);
  camera.near = radius / 100;
  camera.far = radius * 50;
  camera.position
    .copy(sphere.center)
    .add(
      new Vector3(0.7, 0.45, 1).normalize().multiplyScalar((radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.05),
    );
  camera.lookAt(sphere.center);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();

  const info: GltfInfo = {
    name,
    meshes: 0,
    materials: 0,
    vertices: 0,
    triangles: 0,
    animations: clips.length,
    skinned: 0,
    morph: 0,
    instanced: 0,
    linesPoints: 0,
    radius,
    loadMs: Math.round(loadMs),
    clips: clips.map((c) => c.name),
    bones: 0,
  };
  const materials = new Set<unknown>();
  gltf.scene.traverse((o) => {
    const m = o as Mesh & { isSkinnedMesh?: boolean; isInstancedMesh?: boolean; isLine?: boolean; isPoints?: boolean };
    if ((o as { isBone?: boolean }).isBone) info.bones++;
    if (m.isLine || m.isPoints) info.linesPoints++;
    if (!m.isMesh) return;
    info.meshes++;
    if (m.isSkinnedMesh) info.skinned++;
    if (m.morphTargetInfluences?.length) info.morph++;
    if (m.isInstancedMesh) info.instanced++;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) materials.add(mat);
    const g = m.geometry;
    const positions = g.attributes.position?.count ?? 0;
    info.vertices += positions;
    info.triangles += (g.index ? g.index.count : positions) / 3;
  });
  info.materials = materials.size;
  info.triangles = Math.round(info.triangles);
  return { scene, counts: {}, gltf: info, animations: clips, policy: 'auto' };
};
