import { describe, expect, it } from 'vitest';
import { BatchedMesh } from 'three';
import { VERSION } from '../../src/index.js';

describe('toolchain smoke', () => {
  it('imports three core and the library entry in node', () => {
    expect(typeof BatchedMesh).toBe('function');
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
