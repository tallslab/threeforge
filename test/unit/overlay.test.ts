import { describe, expect, it } from 'vitest';
import { formatOverlay } from '../../src/overlay/index.js';
import type { FrameSnapshot } from '../../src/ledger/snapshot.js';

const frame: FrameSnapshot = {
  schemaVersion: 1,
  env: { three: '186', backend: 'webgl2', multiDraw: true },
  totals: { submissions: 29, sceneSubmissions: 28, gpuDraws: 29, reportedDrawCalls: 29, unattributed: 0, programSwitches: 8, programs: 18, triangles: 1234, instances: 512, instancesDrawn: 400, drawCommands: 413 },
  passes: [{ id: 'main', submissions: 29, gpuDraws: 29 }],
  byReason: {
    batched: { submissions: 15, gpuDraws: 15, top: ['forge:batch:aa:0'] },
    dynamic: { submissions: 10, gpuDraws: 10, top: ['prop-1'] },
    'renderer-internal': { submissions: 1, gpuDraws: 1, top: ['Output Color Transform'] },
    skinned: { submissions: 2, gpuDraws: 2, top: ['skinned-0'] },
    'unique-material': { submissions: 1, gpuDraws: 1, top: ['ground'] },
  },
  programs: {},
};

describe('formatOverlay', () => {
  it('leads with backend, scene submissions against the budget and a pass mark', () => {
    const lines = formatOverlay(frame, 30);
    expect(lines[0]).toContain('webgl2');
    expect(lines[0]).toContain('28 / 30');
    expect(lines[0]).toContain('PASS');
    expect(formatOverlay(frame, 20)[0]).toContain('FAIL');
  });

  it('shows the cost line and reasons sorted by count, excluding renderer-internal work', () => {
    const lines = formatOverlay(frame, 30);
    expect(lines[1]).toContain('gpu draws 29');
    expect(lines[1]).toContain('unattributed 0');
    expect(lines[1]).toContain('switches 8');
    const reasons = lines.slice(2).map((l) => l.trim().split(/\s+/)[0]);
    expect(reasons).toEqual(['batched', 'dynamic', 'skinned', 'unique-material']);
    expect(lines.join('\n')).not.toContain('renderer-internal');
  });

  it('omits the budget when none is given', () => {
    const lines = formatOverlay(frame);
    expect(lines[0]).toContain('28 submissions');
    expect(lines[0]).not.toContain('/');
  });
});
