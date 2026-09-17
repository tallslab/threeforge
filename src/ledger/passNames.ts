import type { Camera, Light, Object3D, Scene } from 'three';
import type { FrameState } from './frameState.js';
import { isVsmBlur } from './reasons.js';
import type { LedgerRenderer } from './rendererPatch.js';

/** A light as the ledger's walk reads it. */
export type WalkedLight = Light & {
  isPointLight?: boolean;
  shadow?: { camera?: Camera; mapSize: { x: number; y: number } };
};

/** A shadow-casting light walked this frame, and the pass id its shadow map renders under. */
export interface ShadowPass {
  light: WalkedLight;
  id: string;
}

/**
 * The pass id of a `render()` call: the shadow pass of `shadowPass` (the frame's walk gave the camera one), a VSM blur
 * right after a map, `override`, `fullscreen` for a root that is no scene, `main` for the frame's first scene, else a
 * `nested:`/`scene:` id unique in the frame. Claims the main scene and notes the last shadow pass on `state`.
 */
export function passIdOf(
  state: FrameState,
  scene: Object3D,
  isScene: boolean,
  shadowPass: ShadowPass | undefined,
  renderer: LedgerRenderer | null,
): string {
  if (shadowPass) {
    state.lastShadowPass = shadowPass.id;
    return shadowPass.id;
  }
  // ShadowNode.vsmPass blurs the map it just rendered with two quads, each its own render() call.
  if (state.lastShadowPass !== null && isVsmBlur(scene)) return `${state.lastShadowPass}:vsm`;
  if ((scene as Scene).overrideMaterial) return 'override';
  if (!isScene) return 'fullscreen';
  if (state.mainScene === null) {
    state.mainScene = scene;
    return 'main';
  }
  if (state.mainScene === scene) {
    // A nested render of the main scene: reflections, portals, picking passes. Name it after its target.
    const target = renderer?.getRenderTarget?.();
    const name = target?.texture?.name || target?.name;
    return uniquePassId(`nested:${name || ++state.nestedScenes}`, state.passIds);
  }
  return uniquePassId(`scene:${scene.name || ++state.nestedScenes}`, state.passIds);
}

/**
 * A pass id no other pass of this frame has: the first pass of a name keeps the bare id, later ones get `#2`, `#3`
 * and so on, so two reflectors whose targets are both named `reflection` are two rows, not one sum. The same rule as
 * `shadowPassIds` over the same frame-wide set. The fixed ids (`main`, `override`, `fullscreen`, `:vsm`) skip it:
 * several post-processing quads share `fullscreen` by design.
 */
export function uniquePassId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  let k = 2;
  while (taken.has(`${base}#${k}`)) k++;
  const id = `${base}#${k}`;
  taken.add(id);
  return id;
}
