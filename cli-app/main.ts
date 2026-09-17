/**
 * The harness page `threeforge analyze` ships and drives: load a glTF from `?file=`, attach the ledger, build a
 * World with policy `auto`, and publish `window.__threeforge` (the agent hook) plus `window.__threeforgeCli`
 * (asset facts, readiness). No animation loop: the CLI renders frames through the hook.
 */

import {
  AmbientLight,
  type AnimationClip,
  AnimationMixer,
  Box3,
  Color,
  DirectionalLight,
  type Mesh,
  PerspectiveCamera,
  Scene,
  Sphere,
  Vector3,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { PMREMGenerator, WebGPURenderer } from 'three/webgpu';
import {
  createLoader,
  DrawCallLedger,
  describeError,
  detectTier,
  disposeLoader,
  exposeToAgents,
  gpuName,
  MaterialRegistry,
  type Tier,
  tierInputFromNavigator,
  World,
} from 'threeforge';

interface CliFacts {
  ready: boolean;
  error?: string;
  asset?: {
    meshes: number;
    materials: number;
    vertices: number;
    triangles: number;
    animations: number;
    skinned: number;
    morph: number;
    loadMs: number;
  };
  /** Move the camera to orbit view `i` of `n` around the asset (30° elevation); `i = -1` restores the default framing. */
  setView?(i: number, n: number): void;
}
declare global {
  interface Window {
    __threeforgeCli: CliFacts;
  }
}

const params = new URLSearchParams(location.search);
try {
  const file = params.get('file');
  if (!file) throw new Error('missing ?file=');
  const backend = params.get('backend') === 'webgpu' ? 'webgpu' : 'webgl2';
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ canvas, antialias: false, forceWebGL: backend === 'webgl2' });
  await renderer.init();
  renderer.setPixelRatio(1);
  renderer.setSize(800, 600, false);
  const actual = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2';
  if (actual !== backend) throw new Error(`requested ${backend} but the browser gave ${actual}`);

  const registry = new MaterialRegistry();
  const ledger = new DrawCallLedger({ registry });
  ledger.attach(renderer);

  const gpu = gpuName(renderer);
  const requested = params.get('tier');
  const tier: Tier =
    requested && requested !== 'auto' ? (requested as Tier) : detectTier(tierInputFromNavigator(gpu, navigator));
  ledger.setEnvironment({ tier, gpu, dpr: 1, viewport: [800, 600] });

  const loader = await createLoader(renderer, { decoders: './_decoders/' });

  const t0 = performance.now();
  const gltf = await loader.loadAsync(file);
  const loadMs = performance.now() - t0;
  disposeLoader(loader);

  const scene = new Scene();
  scene.background = new Color(0x202830);
  scene.add(gltf.scene);
  const roomEnvironment = new RoomEnvironment();
  const pmrem = new PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(roomEnvironment, 0.04).texture;
  pmrem.dispose();
  roomEnvironment.dispose();
  const key = new DirectionalLight(0xffffff, 1.5);
  key.position.set(1, 2, 1.5);
  scene.add(new AmbientLight(0xffffff, 0.2), key);
  const clips: AnimationClip[] = gltf.animations;
  if (clips.length > 0) {
    const mixer = new AnimationMixer(gltf.scene);
    for (const clip of clips) mixer.clipAction(clip).play();
    mixer.setTime(0.7);
  }
  scene.updateMatrixWorld(true);

  const camera = new PerspectiveCamera(60, 800 / 600, 0.1, 1000);
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

  let meshes = 0;
  let vertices = 0;
  let triangles = 0;
  let skinned = 0;
  let morph = 0;
  const materials = new Set<unknown>();
  gltf.scene.traverse((o) => {
    const m = o as Mesh & { isSkinnedMesh?: boolean };
    if (!m.isMesh) return;
    meshes++;
    if (m.isSkinnedMesh) skinned++;
    if (m.morphTargetInfluences?.length) morph++;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) materials.add(mat);
    vertices += m.geometry.attributes.position?.count ?? 0;
    triangles += (m.geometry.index ? m.geometry.index.count : (m.geometry.attributes.position?.count ?? 0)) / 3;
  });

  const bake = params.get('bake');
  const world = new World(scene, {
    registry,
    ledger,
    policy: (params.get('policy') as 'auto' | 'tagged' | null) ?? 'auto',
    animations: clips,
    ...(bake ? { bake: bake === 'buried' ? { removeBuried: true } : true } : {}),
  });
  exposeToAgents({ ledger, world, renderer, scene, camera });
  const home = camera.position.clone();
  const setView = (i: number, n: number): void => {
    if (i < 0) camera.position.copy(home);
    else {
      const a = (i / Math.max(1, n)) * Math.PI * 2;
      const distance = home.distanceTo(sphere.center);
      camera.position.set(
        sphere.center.x + Math.cos(a) * distance * Math.cos(Math.PI / 6),
        sphere.center.y + distance * Math.sin(Math.PI / 6),
        sphere.center.z + Math.sin(a) * distance * Math.cos(Math.PI / 6),
      );
    }
    camera.lookAt(sphere.center);
    camera.updateMatrixWorld();
  };
  window.__threeforgeCli = {
    ready: true,
    asset: {
      meshes,
      materials: materials.size,
      vertices,
      triangles: Math.round(triangles),
      animations: clips.length,
      skinned,
      morph,
      loadMs,
    },
    setView,
  };
} catch (error) {
  window.__threeforgeCli = {
    ready: false,
    error: describeError(error, 'stack'),
  };
  throw error;
}
