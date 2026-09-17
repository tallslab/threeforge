import { describe, expect, it } from 'vitest';
import { mergeIndex } from '../../scripts/fetch-assets.mjs';

const entry = (name: string, bytes = 1) => ({
  name,
  entry: `${name}/${name}.glb`,
  tags: ['t'],
  source: 's',
  bytes,
  files: 1,
});

describe('mergeIndex (fetch-assets run limited to some names)', () => {
  it('keeps every entry the run did not fetch and replaces the fetched one in place', () => {
    const existing = [entry('A'), entry('B'), entry('C')];
    expect(mergeIndex(existing, [entry('B', 99)])).toEqual([entry('A'), entry('B', 99), entry('C')]);
  });

  it('appends an asset the index did not list yet, after the existing entries', () => {
    expect(mergeIndex([entry('A')], [entry('Z'), entry('A', 5)])).toEqual([entry('A', 5), entry('Z')]);
  });

  it('two consecutive single-asset runs over a full index leave the full index (the Fox, then SimpleSkin case)', () => {
    const full = [entry('Duck'), entry('Fox'), entry('Buggy'), entry('SimpleSkin')];
    const afterFox = mergeIndex(full, [entry('Fox')]);
    const afterSkin = mergeIndex(afterFox, [entry('SimpleSkin')]);
    expect(afterSkin.map((e) => e.name)).toEqual(['Duck', 'Fox', 'Buggy', 'SimpleSkin']);
  });

  it('replaces an earlier error entry with the fetched one', () => {
    const failed = { name: 'A', entry: 'A/A.glb', tags: [], source: 's', error: '404 x' };
    expect(mergeIndex([failed, entry('B')], [entry('A')])).toEqual([entry('A'), entry('B')]);
  });

  it('treats a missing or malformed index as empty and drops malformed or duplicate rows', () => {
    expect(mergeIndex(undefined, [entry('A')])).toEqual([entry('A')]);
    expect(mergeIndex({ not: 'an array' }, [entry('A')])).toEqual([entry('A')]);
    expect(mergeIndex([null, 7, { entry: 'x' }, entry('B'), entry('B', 2)], [entry('A')])).toEqual([
      entry('B'),
      entry('A'),
    ]);
  });

  it('does not mutate its inputs', () => {
    const existing = [entry('A'), entry('B')];
    const run = [entry('B', 3)];
    const snapshot = JSON.stringify({ existing, run });
    mergeIndex(existing, run);
    expect(JSON.stringify({ existing, run })).toBe(snapshot);
  });
});
