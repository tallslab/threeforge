import { type Camera, Matrix4, type Mesh } from 'three';
import type { SceneSpace } from './space.js';

const _view = new Matrix4();

/**
 * Whether an occlusion query of `proxy` drawn from `camera` could count no samples while the proxy's target is on
 * screen, so its result must not hide the target. `proxy` is a direct child of `space.root` (the scene): a box geometry
 * placed by its position, with no rotation or scale.
 *
 * A camera outside the box sees a visible target point P through the box's entry point E on the ray from the eye: a
 * front face that is drawn and passes the depth test wherever P does, unless E lies in front of the near plane. The box
 * is convex, so that happens only when the near-plane rectangle meets the box. From inside the box every face is
 * back-facing. So the test is true when either:
 * - the eye is inside the box grown by twice `camera.near` (in the camera's units), or
 * - the near-plane rectangle's bounding box meets the box (a wide field of view, or an orthographic near plane through
 *   the box).
 *
 * Both are measured in the scene's space: the camera's frame is `inverse(scene.matrixWorld) * camera.matrixWorld`, and a
 * view-space length r spans at most r times the length of that frame's row i along scene axis i. The near-plane
 * rectangle comes from the projection matrix's x and y rows (`Matrix4.makePerspective` and `makeOrthographic`), which
 * neither the coordinate system nor a reversed depth buffer changes. No allocation.
 */
export function cameraNearProxy(camera: Camera, proxy: Mesh, space: SceneSpace): boolean {
  const bounds = proxy.geometry.boundingBox;
  if (bounds === null) return true;
  const e = (
    space.update() ? _view.copy(camera.matrixWorld) : _view.multiplyMatrices(space.inverse, camera.matrixWorld)
  ).elements;
  const cx = proxy.position.x + (bounds.min.x + bounds.max.x) / 2;
  const cy = proxy.position.y + (bounds.min.y + bounds.max.y) / 2;
  const cz = proxy.position.z + (bounds.min.z + bounds.max.z) / 2;
  const hx = (bounds.max.x - bounds.min.x) / 2;
  const hy = (bounds.max.y - bounds.min.y) / 2;
  const hz = (bounds.max.z - bounds.min.z) / 2;
  const near = (camera as Camera & { near?: number }).near ?? 0;

  const grow = Math.max(0, 2 * near);
  if (
    Math.abs(e[12]! - cx) <= hx + grow * Math.hypot(e[0]!, e[4]!, e[8]!) &&
    Math.abs(e[13]! - cy) <= hy + grow * Math.hypot(e[1]!, e[5]!, e[9]!) &&
    Math.abs(e[14]! - cz) <= hz + grow * Math.hypot(e[2]!, e[6]!, e[10]!)
  ) {
    return true;
  }

  // The near-plane rectangle in view space: centre (mx, my, -near), half size (sx, sy).
  const p = camera.projectionMatrix.elements;
  let mx: number;
  let my: number;
  let sx: number;
  let sy: number;
  if (p[15] === 0) {
    // Perspective: at view depth `near`, x = near * (ndc.x + p[8]) / p[0].
    mx = (near * p[8]!) / p[0]!;
    my = (near * p[9]!) / p[5]!;
    sx = Math.abs(near / p[0]!);
    sy = Math.abs(near / p[5]!);
  } else {
    // Orthographic: x = (ndc.x - p[12]) / p[0].
    mx = -p[12]! / p[0]!;
    my = -p[13]! / p[5]!;
    sx = Math.abs(1 / p[0]!);
    sy = Math.abs(1 / p[5]!);
  }
  const qx = e[0]! * mx + e[4]! * my - e[8]! * near + e[12]!;
  const qy = e[1]! * mx + e[5]! * my - e[9]! * near + e[13]!;
  const qz = e[2]! * mx + e[6]! * my - e[10]! * near + e[14]!;
  return (
    Math.abs(qx - cx) <= hx + Math.abs(e[0]!) * sx + Math.abs(e[4]!) * sy &&
    Math.abs(qy - cy) <= hy + Math.abs(e[1]!) * sx + Math.abs(e[5]!) * sy &&
    Math.abs(qz - cz) <= hz + Math.abs(e[2]!) * sx + Math.abs(e[6]!) * sy
  );
}
