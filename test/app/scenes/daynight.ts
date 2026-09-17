import { Color, DirectionalLight, HemisphereLight } from 'three';
import { DayNight, ShadowBudget } from 'threeforge';
import { buildNaiveScene } from '../../scenes/naive.js';
import type { BenchBuilder } from './index.js';

const NIGHT_SKY = new Color(0x1a2140);
const DAY_SKY = new Color(0xbfd7ff);

/**
 * The village under a time-of-day cycle: one shadow-casting sun (2048² map) plus a hemisphere sky. The optimized
 * variant swaps the hand-rolled lights for DayNight (sun, hemisphere, background; the shadow map re-renders only
 * when the sun moved 0.4°, every second bench frame) and sizes the map with ShadowBudget. The gradient dome is a
 * full-screen opaque layer the naive scene never paid for, so the bench leaves it off (`?dome=1` adds it).
 */
export const daynight: BenchBuilder = async ({ renderer, camera, params, tier }) => {
  const count = Number(params.get('count') ?? '300');
  const n = buildNaiveScene(Number(params.get('seed') ?? '1'), { count, shapes: 40 });
  const scene = n.scene;
  scene.name = 'daynight';
  scene.remove(n.lights.ambient, n.lights.directional, n.lights.directional.target);
  renderer.shadowMap.enabled = true;
  const sun = new DirectionalLight(0xfff1e0, 3);
  sun.name = 'sun';
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -140;
  sc.right = sc.top = 140;
  sc.near = 1;
  sc.far = 400;
  sc.updateProjectionMatrix();
  const sky = new HemisphereLight(DAY_SKY.getHex(), 0x5a4a3a, 0.6);
  sky.name = 'sky';
  scene.add(sun, sun.target, sky);
  scene.background = new Color(0x202830);
  camera.position.set(0, 110, 150);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  let dayNight: DayNight | null = null;
  /** `t` is the hour of day: the sun rises at 6 and sets at 18; below the horizon it dims to a faint moon. */
  const setTime = (t: number): void => {
    if (dayNight) dayNight.setTime(t);
    else {
      const angle = ((t - 6) / 24) * Math.PI * 2;
      const elevation = Math.sin(angle);
      sun.position.set(Math.cos(angle) * 200, Math.max(20, elevation * 200), 60);
      sun.intensity = Math.max(0.05, elevation) * 3;
      sky.color.copy(NIGHT_SKY).lerp(DAY_SKY, Math.max(0, elevation));
      (scene.background as Color).copy(NIGHT_SKY).lerp(DAY_SKY, Math.max(0, elevation) * 0.6);
    }
    for (const d of n.dynamics) d.rotation.y = t * 0.6;
  };
  const t0 = Number(params.get('t') ?? '10');
  setTime(t0);
  const prepare = (): void => {
    scene.remove(sun, sun.target, sky);
    dayNight = new DayNight(scene, {
      dome: params.get('dome') === '1',
      shadow: { mapSize: 2048, extent: 140, near: 1, far: 400, everyDegrees: 0.4 },
      fog: false,
    });
    new ShadowBudget({ tier }).apply(scene);
    setTime(t0);
  };
  return { scene, counts: { props: count, shadowMap: 2048 }, setTime, prepare };
};
