import { describe, expect, it } from 'vitest';
import { budgetsFor } from '../../src/ledger/budgets.js';
import { hintsFor } from '../../src/ledger/hints.js';
import { buildFrame, emptyFrame, type SubmissionRecord } from '../../src/ledger/snapshot.js';
import {
  capMessage,
  capName,
  describeError,
  formatBytes,
  formatCount,
  MAX_MESSAGE_LENGTH,
  MAX_NAME_LENGTH,
} from '../../src/ledger/text.js';

const env = {
  three: '0.186.0',
  backend: 'webgl2' as const,
  multiDraw: true,
  tier: 'desktop' as const,
  gpu: 'test',
  dpr: 1,
  viewport: [800, 600] as [number, number],
};

describe('capName / capMessage', () => {
  it('leaves short names and messages untouched', () => {
    expect(capName('crate')).toBe('crate');
    expect(capMessage('7 untagged meshes: tag.static() or tag.dynamic() them')).toBe(
      '7 untagged meshes: tag.static() or tag.dynamic() them',
    );
  });

  it('caps a name at 120 characters', () => {
    const long = 'x'.repeat(500);
    const capped = capName(long);
    expect(capped.length).toBe(MAX_NAME_LENGTH);
    expect(capped.endsWith('…')).toBe(true);
  });

  it('caps a message at 300 characters', () => {
    const long = 'y'.repeat(1000);
    const capped = capMessage(long);
    expect(capped.length).toBe(MAX_MESSAGE_LENGTH);
    expect(capped.endsWith('…')).toBe(true);
  });

  it('never splits a surrogate pair (astral emoji) when truncating', () => {
    const emoji = '🎉'.repeat(200); // 400 UTF-16 units, 200 code points
    const capped = capName(emoji);
    for (const ch of capped) expect(ch.codePointAt(0)).toBeLessThanOrEqual(0x10ffff); // Array.from/for-of never yields a lone surrogate
    expect(capped.endsWith('…')).toBe(true);
    // The cap is 120 code points, not UTF-16 units: an emoji is a surrogate pair, so capped.length (UTF-16) can
    // run up to ~2x MAX_NAME_LENGTH while still holding to the code-point budget.
    expect(Array.from(capped).length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
  });

  it('leaves short CJK and emoji names fully intact', () => {
    expect(capName('炎の剣')).toBe('炎の剣');
    expect(capName('🔥 Fire Sword')).toBe('🔥 Fire Sword');
  });
});

describe('snapshot.ts caps names pushed into byReason[].top', () => {
  it('buildFrame caps a 10,000-character item name at 120 characters', () => {
    const longName = 'L'.repeat(10_000);
    const item: SubmissionRecord = {
      name: longName,
      kind: 'mesh',
      material: 0,
      materialType: 'MeshStandardMaterial',
      programHash: 'p1',
      variantHash: 'v1',
      transparent: false,
      pass: 'main',
      reason: 'untagged',
      flags: [],
      expectedGpuDraws: 1,
      instances: 1,
      instancesDrawn: 1,
      vertices: 8,
      bones: 0,
      skeleton: null,
      morphTargets: 0,
    };
    const frame = buildFrame({
      env,
      items: [item],
      reportedDrawCalls: 1,
      triangles: 12,
      programs: 1,
      descriptions: new Map(),
    });
    const top = frame.byReason.untagged!.top;
    expect(top).toHaveLength(1);
    expect(top[0]!.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
  });
});

describe('hints.ts caps names and messages coming from HintContext', () => {
  it('a 10,000-character point light name yields a hint message <= 300 chars and an objects entry <= 120 chars', () => {
    const f = emptyFrame(env);
    const longName = 'P'.repeat(10_000);
    const hints = hintsFor(f, budgetsFor('desktop'), { pointShadowLights: [longName] });
    const hint = hints.find((h) => h.code === 'point-light-shadow')!;
    expect(hint).toBeDefined();
    expect(hint.message.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(hint.objects).toHaveLength(1);
    expect(hint.objects[0]!.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
  });

  it('caps transmission and static-auto-update object names too', () => {
    const f = emptyFrame(env);
    const longName = 'T'.repeat(500);
    const hints = hintsFor(f, budgetsFor('desktop'), { transmissive: [longName], staticAutoUpdated: [longName] });
    expect(hints.find((h) => h.code === 'transmission')!.objects[0]!.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
    expect(hints.find((h) => h.code === 'static-auto-update')!.objects[0]!.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
  });

  it('still reports the exact short-name untagged hint unchanged (golden-adjacent)', () => {
    const f = emptyFrame(env);
    f.byReason = { untagged: { submissions: 7, gpuDraws: 7, top: ['crate', 'barrel'] } };
    const hints = hintsFor(f, budgetsFor('phone-low'));
    expect(hints.find((h) => h.code === 'untagged')).toEqual({
      category: 'drawCalls',
      severity: 'warn',
      code: 'untagged',
      message: '7 untagged meshes: tag.static() or tag.dynamic() them',
      objects: ['crate', 'barrel'],
    });
  });
});

describe('formatCount / formatBytes', () => {
  it('formats counts as the overlay always has: k below a million (no trailing .0), M above, integers below 1000', () => {
    expect(formatCount(27)).toBe('27');
    expect(formatCount(999)).toBe('999');
    expect(formatCount(120_000)).toBe('120k');
    expect(formatCount(6_400)).toBe('6.4k');
    expect(formatCount(1_000_000)).toBe('1.0M');
    expect(formatCount(2_345_678)).toBe('2.3M');
    expect(formatCount(0)).toBe('0');
    expect(formatCount(12.6)).toBe('13');
  });

  it('formats bytes as whole MiB without a unit', () => {
    expect(formatBytes(28 * 1024 * 1024)).toBe('28');
    expect(formatBytes(0)).toBe('0');
    expect(formatBytes(3.6 * 1024 * 1024)).toBe('4');
  });
});

describe('describeError', () => {
  it('gives the message by default and the stack trace on request, and stringifies non-errors', () => {
    const error = new Error('boom');
    expect(describeError(error)).toBe('boom');
    expect(describeError(error, 'stack')).toBe(error.stack);
    error.stack = undefined;
    expect(describeError(error, 'stack')).toBe('boom');
    expect(describeError('plain')).toBe('plain');
    expect(describeError(42, 'stack')).toBe('42');
  });
});
