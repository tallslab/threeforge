/** One row of test/assets/files/index.json, as `main` writes it. */
export interface AssetIndexEntry {
  name: string;
  entry: string;
  tags: string[];
  source: string;
  bytes?: number;
  files?: number;
  error?: string;
}

/**
 * The index after a run limited to some names: `existing` with each entry the run fetched replaced in place (matched
 * by `name`) and assets it did not list yet appended. A missing or malformed `existing` counts as empty; rows without
 * a string `name`, and repeats of a name, are dropped. Pure.
 */
export function mergeIndex<T extends { name: string }>(existing: unknown, entries: T[]): Array<T | AssetIndexEntry>;

/** Downloads `names` (every manifest asset when empty) into test/assets/files, writes (or, for a subset, merges) index.json, and returns this run's entries. */
export function main(names?: string[]): Promise<AssetIndexEntry[]>;
