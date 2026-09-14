import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyDecoders, threeLibsDir } from '../../src/cli/decoders.js';

describe('decoders', () => {
  it("finds three's example libs and copies the Draco and Basis decoders", () => {
    expect(existsSync(join(threeLibsDir(), 'basis', 'basis_transcoder.wasm'))).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'forge-decoders-'));
    try {
      const out = copyDecoders(dir);
      expect(out).toEqual({ draco: join(dir, 'draco'), basis: join(dir, 'basis') });
      expect(existsSync(join(dir, 'draco', 'draco_decoder.wasm'))).toBe(true);
      expect(existsSync(join(dir, 'basis', 'basis_transcoder.js'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
