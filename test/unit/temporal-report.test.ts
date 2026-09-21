import { describe, expect, it } from 'vitest';
import { markdown, summarize } from '../../scripts/temporal-report.mjs';

type Annotation = { type: string; description?: string };

/** One spec of Playwright's JSON report, in one project. `status` is Playwright's: expected, unexpected, skipped. */
const spec = (title: string, status: string | null, annotations: Annotation[] = [], project = 'webgl2') => ({
  title,
  file: 'temporal-lod.spec.ts',
  line: 79,
  tags: ['temporal'],
  tests: [{ projectName: project, status: status ?? 'skipped', annotations, results: status ? [{ status }] : [] }],
});
const document = (...specs: unknown[]) => ({ suites: [{ title: 'temporal-lod.spec.ts', specs, suites: [] }] });

describe('temporal report', () => {
  it('lists passed, failed and skipped tests by title and project', () => {
    const listed = document(spec('a', null), spec('b', null), spec('c', null));
    const report = document(spec('a', 'expected'), spec('b', 'unexpected'), spec('c', 'skipped'));
    expect(summarize(listed, report).map((r) => [r.title, r.project, r.status])).toEqual([
      ['a', 'webgl2', 'passed'],
      ['b', 'webgl2', 'failed'],
      ['c', 'webgl2', 'skipped'],
    ]);
  });

  it('gives a skipped test its reason and the pixel-checks note', () => {
    const annotations = [
      { type: 'pixel-checks', description: 'off for webgpu on the swiftshader adapter' },
      { type: 'skip', description: 'screenshots unavailable on this adapter' },
    ];
    const rows = summarize(
      document(spec('a', null, [], 'webgpu')),
      document(spec('a', 'skipped', annotations, 'webgpu')),
    );
    expect(rows[0]!.details).toEqual([
      'screenshots unavailable on this adapter',
      'pixel checks off for webgpu on the swiftshader adapter',
    ]);
  });

  it('gives a failed test the directory its frames were written to', () => {
    const annotations = [{ type: 'temporal-artifacts', description: '/tmp/threeforge-temporal/lod-webgl2-ab12' }];
    const rows = summarize(document(spec('a', null)), document(spec('a', 'unexpected', annotations)));
    expect(rows[0]).toMatchObject({ status: 'failed', details: ['frames: /tmp/threeforge-temporal/lod-webgl2-ab12'] });
  });

  it('reports a listed test that the run never selected as excluded', () => {
    const listed = document(spec('a', null), spec('vat', null));
    expect(summarize(listed, document(spec('a', 'expected'))).map((r) => [r.title, r.status])).toEqual([
      ['a', 'passed'],
      ['vat', 'excluded'],
    ]);
    expect(summarize(listed, document()).map((r) => r.status)).toEqual(['excluded', 'excluded']);
  });

  it('keeps the same title in two projects apart', () => {
    const listed = document(spec('a', null, [], 'webgl2'), spec('a', null, [], 'webgpu'));
    const report = document(spec('a', 'expected', [], 'webgl2'), spec('a', 'skipped', [], 'webgpu'));
    expect(summarize(listed, report).map((r) => [r.project, r.status])).toEqual([
      ['webgl2', 'passed'],
      ['webgpu', 'skipped'],
    ]);
  });

  it('says in words when a project checked no pixels at all', () => {
    const skipped = [{ type: 'pixel-checks', description: 'off for webgpu on the swiftshader adapter' }];
    const rows = summarize(document(spec('a', null, [], 'webgpu')), document(spec('a', 'skipped', skipped, 'webgpu')));
    const text = markdown(rows);
    expect(text).toContain('| a | webgpu | skipped |');
    expect(text).toContain('webgpu: every temporal test was skipped, so no pixels were checked on this adapter.');
    expect(markdown(summarize(document(spec('a', null)), document(spec('a', 'expected'))))).not.toContain('no pixels');
  });
});
