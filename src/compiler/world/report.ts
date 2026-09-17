import type { BakedGroup } from '../batchStatics.js';
import type { BakeSummary } from './types.js';

/** Totals over the baked groups of one compile; `unbakeableEntries` is `BatchResult.unbakeable`. */
export function bakeSummary(baked: readonly BakedGroup[], unbakeableEntries: number): BakeSummary {
  const sum: BakeSummary = {
    groups: baked.length,
    inputTriangles: 0,
    triangles: 0,
    contactFaces: 0,
    keptCoincidentFaces: 0,
    duplicateFaces: 0,
    buriedFaces: 0,
    weldedVertices: 0,
    excludedEntries: 0,
    keptDuplicateFaces: 0,
    unbakeableEntries,
  };
  for (const { report } of baked) {
    sum.inputTriangles += report.inputTriangles;
    sum.triangles += report.triangles;
    sum.contactFaces += report.contactFaces;
    sum.keptCoincidentFaces += report.keptCoincidentFaces;
    sum.duplicateFaces += report.duplicateFaces;
    sum.buriedFaces += report.buriedFaces;
    sum.weldedVertices += report.weldedVertices;
    sum.excludedEntries += report.excludedEntries;
    sum.keptDuplicateFaces += report.keptDuplicateFaces;
  }
  return sum;
}
