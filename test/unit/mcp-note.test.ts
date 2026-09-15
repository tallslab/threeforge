import { describe, expect, it } from 'vitest';
import { UsageError } from '../../src/cli/errors.js';
import { DATA_NOTE, fail, ok } from '../../src/cli/mcp.js';

describe('mcp result shaping', () => {
  it('ok() with no note returns a single JSON text block, as before', () => {
    const result = ok({ a: 1 });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');
    expect(JSON.parse(result.content[0]!.text)).toEqual({ a: 1 });
  });

  it('ok() with a note appends a second, short text block marking the JSON as data, not instructions', () => {
    const result = ok({ a: 1 }, DATA_NOTE);
    expect(result.content).toHaveLength(2);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ a: 1 });
    expect(result.content[1]!.type).toBe('text');
    expect(result.content[1]!.text).toBe(DATA_NOTE);
    expect(result.content[1]!.text.length).toBeGreaterThan(20);
    expect(result.content[1]!.text.length).toBeLessThan(600);
  });

  it('fail() is unchanged: a single JSON error block, never a note', () => {
    const result = fail(new UsageError('bad input'));
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ error: 'bad input', code: 2 });
  });
});
