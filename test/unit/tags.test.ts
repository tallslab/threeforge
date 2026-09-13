import { describe, expect, it } from 'vitest';
import { Mesh, Object3D } from 'three';
import { tag } from '../../src/tags.js';

describe('tag', () => {
  it('marks an object static and reads it back', () => {
    const o = new Mesh();
    expect(tag.of(o)).toBeUndefined();
    tag.static(o);
    expect(tag.of(o)).toBe('static');
  });

  it('marks an object dynamic and returns the object for chaining', () => {
    const o = new Object3D();
    expect(tag.dynamic(o)).toBe(o);
    expect(tag.of(o)).toBe('dynamic');
  });

  it('stores the tag under userData.forge so it survives clone() and toJSON()', () => {
    const o = tag.static(new Object3D());
    expect(o.userData.forge).toBe('static');
    expect(tag.of(o.clone())).toBe('static');
  });
});
