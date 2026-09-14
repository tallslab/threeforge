import { describe, expect, it } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, InstancedBufferGeometry, Mesh, MeshBasicMaterial, PlaneGeometry, Points, PointsMaterial, Scene, Sprite, SpriteMaterial } from 'three';
import { ParticleBudget } from '../../src/overdraw/ParticleBudget.js';

function cloud(name: string, n: number, size = 2): Points {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(new Float32Array(n * 3), 3));
  const p = new Points(g, new PointsMaterial({ size, transparent: true }));
  p.name = name;
  return p;
}

function spriteBatch(name: string, n: number): Mesh {
  const g = new InstancedBufferGeometry();
  const plane = new PlaneGeometry(1, 1);
  g.setIndex(plane.getIndex());
  g.setAttribute('position', plane.getAttribute('position'));
  g.instanceCount = n;
  const m = new Mesh(g, new MeshBasicMaterial());
  m.name = name;
  m.userData.forge = { kind: 'sprites', cap: Infinity };
  return m;
}

function scene(): { scene: Scene; a: Points; b: Points; c: Points; batch: Mesh } {
  const s = new Scene();
  const a = cloud('smoke', 1000);
  const b = cloud('sparks', 2000);
  const c = cloud('magic', 1000);
  const batch = spriteBatch('forge:sprites:x:0', 1000);
  s.add(a, b, c, batch);
  return { scene: s, a, b, c, batch };
}

describe('ParticleBudget', () => {
  it('does nothing when the total fits the tier budget', () => {
    const { scene: s, a } = scene();
    const report = new ParticleBudget({ tier: 'phone-low' }).apply(s);
    expect(report).toMatchObject({ tier: 'phone-low', budget: 5000, before: 5000, after: 5000, ratio: 1 });
    expect(report.systems).toHaveLength(4);
    expect(a.geometry.drawRange.count).toBe(Infinity);
  });

  it('scales every system by the same ratio over budget, caps sprite batches, scales point sizes, and releases', () => {
    const { scene: s, a, b, c, batch } = scene();
    const budget = new ParticleBudget({ tier: 'phone-low', particles: 2500, pointSizeScale: 0.75 });
    const report = budget.apply(s);
    expect(report).toMatchObject({ budget: 2500, before: 5000, after: 2500, ratio: 0.5 });
    expect(report.systems.map((x) => [x.name, x.kind, x.count, x.drawn])).toEqual([
      ['smoke', 'points', 1000, 500],
      ['sparks', 'points', 2000, 1000],
      ['magic', 'points', 1000, 500],
      ['forge:sprites:x:0', 'sprites', 1000, 500],
    ]);
    expect([a, b, c].map((p) => p.geometry.drawRange.count)).toEqual([500, 1000, 500]);
    expect((batch.userData.forge as { cap: number }).cap).toBe(500);
    expect((a.material as PointsMaterial).size).toBe(1.5);
    // Idempotent: applying again does not compound.
    expect(budget.apply(s)).toMatchObject({ before: 5000, after: 2500 });
    expect((a.material as PointsMaterial).size).toBe(1.5);
    budget.release();
    expect([a, b, c].map((p) => p.geometry.drawRange.count)).toEqual([Infinity, Infinity, Infinity]);
    expect((batch.userData.forge as { cap: number }).cap).toBe(Infinity);
    expect((a.material as PointsMaterial).size).toBe(2);
  });

  it('respects an existing drawRange as the count and defaults pointSizeScale to 0.75 on phone-low', () => {
    const { scene: s, a } = scene();
    a.geometry.setDrawRange(0, 400);
    const report = new ParticleBudget({ tier: 'phone-low', particles: 2200 }).apply(s);
    expect(report.before).toBe(4400);
    expect(report.systems[0]).toMatchObject({ name: 'smoke', count: 400, drawn: 200 });
    expect((a.material as PointsMaterial).size).toBe(1.5);
    expect(new ParticleBudget({ tier: 'desktop' }).apply(scene().scene).systems[0]).toMatchObject({ drawn: 1000 });
  });

  it('counts single sprites (uncappable) and fits the cappable systems under the total', () => {
    const { scene: s, a, b, c } = scene();
    const singles = [new Sprite(new SpriteMaterial()), new Sprite(new SpriteMaterial())];
    singles[0]!.name = 'bar-0';
    s.add(...singles);
    const report = new ParticleBudget({ tier: 'phone-low', particles: 2502, pointSizeScale: 1 }).apply(s);
    expect(report.before).toBe(5002);
    expect(report.after).toBeLessThanOrEqual(2502);
    expect(report.systems.filter((x) => x.kind === 'sprite')).toEqual([{ name: 'bar-0', kind: 'sprite', count: 1, drawn: 1 }, { name: '', kind: 'sprite', count: 1, drawn: 1 }]);
    expect([a, b, c].map((p) => p.geometry.drawRange.count)).toEqual([500, 1000, 500]);
  });
});
