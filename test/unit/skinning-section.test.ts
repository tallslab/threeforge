import { describe, expect, it } from 'vitest';
import { skinningOf } from '../../src/ledger/sections.js';
import type { SubmissionRecord } from '../../src/ledger/snapshot.js';

const record = (over: Partial<SubmissionRecord>): SubmissionRecord => ({ name: 'x', kind: 'mesh', materialType: 'MeshStandardMaterial', programHash: 'p', variantHash: 'v', transparent: false, pass: 'main', reason: 'batched', flags: [], expectedGpuDraws: 1, instances: 1, instancesDrawn: 1, vertices: 0, bones: 0, skeleton: null, morphTargets: 0, ...over });

describe('skinningOf with animated instances', () => {
  it('counts vat instances and their vertices next to bone-skinned draws, main pass only (numbered shadow passes included)', () => {
    const items = [
      record({ name: 'hero', kind: 'skinned', vertices: 1200, bones: 40, skeleton: 0 }),
      record({ name: 'forge:vat:body', reason: 'vat-instanced', instances: 25, instancesDrawn: 25, vertices: 804 }),
      record({ name: 'forge:vat:head', reason: 'vat-instanced', instances: 25, instancesDrawn: 20, vertices: 455 }),
      record({ name: 'forge:vat:body', reason: 'vat-instanced', pass: 'shadow:sun', instances: 25, instancesDrawn: 25, vertices: 804 }),
      record({ name: 'forge:vat:body', reason: 'vat-instanced', pass: 'shadow:lamp#2', instances: 25, instancesDrawn: 25, vertices: 804 }),
      record({ name: 'hero', kind: 'skinned', pass: 'shadow:lamp#2', vertices: 1200, bones: 40, skeleton: 0 }),
    ];
    expect(skinningOf(items)).toEqual({ submissions: 1, vertices: 1200, bones: 40, skeletons: 1, maxBones: 40, morphTargets: 0, vatInstances: 45, vatVertices: 25 * 804 + 20 * 455 });
  });
});
