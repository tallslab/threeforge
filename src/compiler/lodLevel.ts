export interface CullingLod {
  /** Distance thresholds; level i is used from distances[i-1] onward. */
  distances: number[];
  /** Base geometryId -> geometryIds per level (level 0 = base). Geometries not listed always draw at level 0. */
  geometryIds: Map<number, number[]>;
}

/** Index of the LOD level for a camera distance. */
export function levelFor(distance: number, distances: number[]): number {
  let level = 0;
  while (level < distances.length && distance >= distances[level]!) level++;
  return level;
}
