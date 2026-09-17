import { BoxGeometry, ConeGeometry, SphereGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { generateLods } from '../../src/lod/generateLods.js';

describe('generateLods on the field geometries', () => {
  it('handles the box, low-poly sphere and cone without throwing', async () => {
    for (const g of [new BoxGeometry(2, 2, 2), new SphereGeometry(1.2, 8, 6), new ConeGeometry(1, 3, 8)]) {
      const lods = await generateLods(g, { ratios: [0.5, 0.2] });
      expect(lods).toHaveLength(2);
      expect(lods[1]!.index!.count).toBeLessThanOrEqual(lods[0]!.index!.count);
      expect(lods[0]!.index!.count).toBeLessThanOrEqual(g.index!.count);
      expect(lods[0]!.index!.count).toBeGreaterThan(0);
    }
  });
});
