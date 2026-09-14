import { describe, expect, it } from 'vitest';
import { DirectionalLight, PointLight, Scene, SpotLight } from 'three';
import { ShadowBudget } from '../../src/lighting/ShadowBudget.js';

function lit() {
  const scene = new Scene();
  const sun = new DirectionalLight();
  sun.name = 'sun';
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const spot = new SpotLight();
  spot.name = 'spot';
  spot.castShadow = true;
  spot.shadow.mapSize.set(1024, 1024);
  const point = new PointLight();
  point.name = 'lamp';
  point.castShadow = true;
  point.shadow.mapSize.set(512, 512);
  const plain = new PointLight();
  plain.name = 'plain';
  scene.add(sun, spot, point, plain);
  return { scene, sun, spot, point, plain };
}
const MiB = 1024 * 1024;

describe('ShadowBudget', () => {
  it('halves the largest map until the tier budget holds and keeps point shadows on desktop', () => {
    const { scene, sun, spot, point } = lit();
    const report = new ShadowBudget({ tier: 'desktop' }).apply(scene);
    expect(report.budget).toBe(4 * MiB);
    expect(report.before).toBe(2048 * 2048 + 1024 * 1024 + 6 * 512 * 512);
    expect(report.after).toBeLessThanOrEqual(report.budget);
    expect(sun.shadow.mapSize.x).toBe(1024);
    expect(spot.shadow.mapSize.x).toBe(1024);
    expect(point.castShadow).toBe(true);
    expect(point.shadow.mapSize.x).toBe(512);
    expect(report.lights.map((l) => [l.name, l.faces, l.from[0], l.to[0], l.castShadow])).toEqual([
      ['sun', 1, 2048, 1024, true],
      ['spot', 1, 1024, 1024, true],
      ['lamp', 6, 512, 512, true],
    ]);
  });

  it('turns point shadows off on phone tiers, respects minMapSize, and can switch shadows off for listed tiers', () => {
    const { scene, sun, spot, point } = lit();
    const mid = new ShadowBudget({ tier: 'phone-mid' }).apply(scene);
    expect(point.castShadow).toBe(false);
    expect(mid.after).toBeLessThanOrEqual(1 * MiB);
    expect(sun.shadow.mapSize.x).toBeGreaterThanOrEqual(256);
    expect(spot.shadow.mapSize.x).toBeGreaterThanOrEqual(256);
    const { scene: s2, sun: sun2, spot: spot2 } = lit();
    const floor = new ShadowBudget({ tier: 'phone-low', minMapSize: 1024 }).apply(s2);
    expect(sun2.shadow.mapSize.x).toBe(1024);
    expect(spot2.shadow.mapSize.x).toBe(1024);
    expect(floor.after).toBeGreaterThan(floor.budget);
    const { scene: s3, sun: sun3, point: point3 } = lit();
    const off = new ShadowBudget({ tier: 'phone-low', off: ['phone-low'] }).apply(s3);
    expect(off.after).toBe(0);
    expect(sun3.castShadow).toBe(false);
    expect(point3.castShadow).toBe(false);
  });

  it('release restores sizes and flags; freeze turns a light into a frozen map with a refresh', () => {
    const { scene, sun, spot, point } = lit();
    const budget = new ShadowBudget({ tier: 'phone-low' });
    budget.apply(scene);
    expect(sun.shadow.mapSize.x).toBeLessThan(2048);
    budget.release();
    expect(sun.shadow.mapSize.x).toBe(2048);
    expect(spot.shadow.mapSize.x).toBe(1024);
    expect(point.castShadow).toBe(true);
    const refresh = ShadowBudget.freeze(sun);
    expect(sun.shadow.autoUpdate).toBe(false);
    expect(sun.shadow.needsUpdate).toBe(true);
    sun.shadow.needsUpdate = false;
    refresh();
    expect(sun.shadow.needsUpdate).toBe(true);
  });
});
