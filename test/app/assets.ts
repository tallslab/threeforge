/** The served asset indexes (`pnpm assets` writes them under test/assets/files). */

export interface AssetEntry {
  name: string;
  entry?: string;
  glbs?: string[];
  error?: string;
}

export async function assetIndex(): Promise<AssetEntry[]> {
  const lists = await Promise.all(
    ['/index.json', '/kits-index.json'].map((u) =>
      fetch(u)
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => []),
    ),
  );
  return lists.flat() as AssetEntry[];
}

/** The served path of a named asset's entry file. */
export async function findAsset(name: string): Promise<string> {
  const entry = (await assetIndex()).find((a) => a.name === name);
  if (!entry?.entry) throw new Error(`asset "${name}" not found in test/assets/files (run pnpm assets)`);
  return entry.entry;
}
