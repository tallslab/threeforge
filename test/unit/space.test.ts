import { describe, expect, it } from 'vitest';
import { Matrix4, Object3D, Quaternion, Scene, Vector3 } from 'three';
import { SceneSpace } from '../../src/compiler/space.js';

const world = new Matrix4().compose(new Vector3(1.1, 2.2, -3.3), new Quaternion().setFromAxisAngle(new Vector3(0.2, 1, 0.1).normalize(), 0.7), new Vector3(1, 2, 3));

function expectClose(actual: Matrix4, expected: Matrix4, label: string): void {
  actual.elements.forEach((e, i) => expect(e, `${label} [${i}]`).toBeCloseTo(expected.elements[i]!, 10));
}

describe('SceneSpace', () => {
  it('copies world matrices bit for bit while the root has no transform', () => {
    const scene = new Scene();
    scene.updateMatrixWorld();
    const space = new SceneSpace(scene);
    expect(space.update()).toBe(true);
    const out = space.toLocal(world, new Matrix4());
    expect(Array.from(out.elements)).toEqual(Array.from(world.elements));
    expect(space.scaleX).toBe(1);
    expect(space.scaleY).toBe(1);
  });

  it('multiplies by the inverse of the root world matrix, so the root times the result is the world matrix', () => {
    const scene = new Scene();
    scene.position.set(5, -2, 7);
    scene.rotation.set(0.3, 0.6, -0.2);
    scene.scale.set(2, 3, 0.5);
    scene.updateMatrixWorld();
    const space = new SceneSpace(scene);
    expect(space.update()).toBe(false);
    const local = space.toLocal(world, new Matrix4());
    expectClose(new Matrix4().multiplyMatrices(scene.matrixWorld, local), world, 'root x local');
    expect(space.scaleX).toBeCloseTo(2, 12);
    expect(space.scaleY).toBeCloseTo(3, 12);
  });

  it('re-derives the inverse when the root moves after it was first used, and returns to the fast path at identity', () => {
    const root = new Object3D();
    root.position.set(10, 0, 0);
    root.updateMatrixWorld();
    const space = new SceneSpace(root);
    expectClose(new Matrix4().multiplyMatrices(root.matrixWorld, space.toLocal(world, new Matrix4())), world, 'first matrix');
    root.position.set(-4, 8, 1);
    root.rotation.y = 1.2;
    root.scale.setScalar(0.25);
    root.updateMatrixWorld();
    expectClose(new Matrix4().multiplyMatrices(root.matrixWorld, space.toLocal(world, new Matrix4())), world, 'after the root moved');
    expect(space.scaleX).toBeCloseTo(0.25, 12);
    root.position.set(0, 0, 0);
    root.rotation.y = 0;
    root.scale.setScalar(1);
    root.updateMatrixWorld();
    expect(space.update()).toBe(true);
    expect(Array.from(space.toLocal(world, new Matrix4()).elements)).toEqual(Array.from(world.elements));
  });
  it('counts every change of the root matrix in version, and says when the root mirrors', () => {
    const root = new Object3D();
    root.updateMatrixWorld();
    const space = new SceneSpace(root);
    space.update();
    const start = space.version;
    expect(space.mirrored).toBe(false);
    space.update();
    expect(space.version, 'an unchanged root is not a change').toBe(start);
    root.scale.x = -2;
    root.updateMatrixWorld();
    space.toLocal(world, new Matrix4());
    expect(space.version).toBe(start + 1);
    expect(space.mirrored).toBe(true);
    root.scale.x = 2;
    root.updateMatrixWorld();
    space.update();
    expect(space.version).toBe(start + 2);
    expect(space.mirrored).toBe(false);
  });
});
