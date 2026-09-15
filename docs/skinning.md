# Skinning and crowds with threeforge

The ledger's skinning section counts the main pass's skinned draws, their vertices, the bones every skeleton
updates on the CPU per frame, and, after this module, the characters drawn as animated instances. Two functions
turn a skinned prototype into instanced crowds: `bakeAnimationTexture` and `AnimatedInstances`.

## What a skinned character costs

Every `SkinnedMesh` is its own draw: three uploads the skeleton's bone matrices as a texture per mesh, so 200
characters are 200 submissions (400 when body and head are separate parts) even when they share a mesh and a
material, and every `AnimationMixer` walks its bones on the CPU each frame. Skinned meshes are never batched or
instanced by `compile()`: their vertex positions depend on a per-object skeleton. The budgets per tier are
400 k / 150 k / 60 k skinned vertices and 20 000 / 5 000 / 2 000 bones (desktop / phone-mid / phone-low);
`skinned-crowd` fires at 50 skinned draws.

## bakeAnimationTexture

```ts
import { bakeAnimationTexture } from 'threeforge';
const animation = bakeAnimationTexture(gltf.scene, gltf.animations, { fps: 30 });
// { texture, fps, bones, clips: [{ name, start, frames, duration }], parts: [{ mesh, matrix, boneOffset }], skeletons }
```

Plays every clip on the prototype (moved to the origin for the duration, transform and pose restored) and copies
every distinct skeleton's `boneMatrices` (`bone.matrixWorld × boneInverse`, what three uploads as its bone
texture) into one float texture: a row per frame, four RGBA texels per bone (the matrix columns), skeletons after
each other in the row (`parts[i].boneOffset`). Clips follow each other in rows; `clips[i].start` is the first row,
`frames` is `ceil(duration × fps) + 1` so the last frame is the clip's end pose. The Kenney mini characters
(two 7-bone skeletons, 33 clips) bake to a 56 × 450 texture at 30 fps: 400 KB, shared by every instance.

## AnimatedInstances

```ts
import { AnimatedInstances } from 'threeforge';
const crowd = new AnimatedInstances({ animation, count: 200 }).addTo(scene);
crowd.setMatrixAt(i, matrix);                        // the character's transform; each part's offset is folded in
crowd.setClipAt(i, 'walk', { offset: i * 0.13, speed: 1 });
crowd.setTime(seconds);                              // one clock for every instance, each frame
```

One `Mesh` per part of the prototype over an `InstancedBufferGeometry` that shares the part's vertex buffers, with
a `MeshStandardNodeMaterial` (colour, maps and flags copied from the part's material, or from `material`). Its
vertex stage fetches the four bone matrices of the instance's current frame from the texture and applies three's
skinning formula, then the instance matrix; the fragment stage is three's standard lighting. Per instance:
`[clipStart, clipFrames, timeOffset, speed]` and a matrix, in one interleaved instanced buffer. The meshes are
named `forge:vat:<part>` and carry `userData.forge = { kind: 'vat', instances }`, which the ledger reports as
reason `vat-instanced` with `skinning.vatInstances` and `vatVertices`. Do not tag them: a tag would overwrite
that marker. Skinned parts sharing a skeleton or not both work (each part reads its own bone range).

What it does not do: per-instance clip blending (one clip per instance, switch with `setClipAt`), root motion,
and frustum culling per instance (`frustumCulled = false`; use it for crowds that stay mostly on screen or split
large crowds by region). The measured overdraw (`ledger.measureOverdraw`) counts animated instances in their animated
pose: its count material is a node material, and three's override copies each material's `positionNode` onto it, so
an instance covers the pixels its current frame covers, as a skinned original at the same time does.

## Reading the section

| number | means | act with |
|---|---|---|
| `submissions` ≥ 50 (`skinned-crowd`) | one draw per character | `bakeAnimationTexture` + `AnimatedInstances` |
| `bones` above the tier budget (`bones-over-budget`) | mixers update too many bones on the CPU | animated instances (no mixers), fewer skeletons |
| `vertices` above the tier budget (`skinned-vertices`) | too much skinned geometry | LOD the characters, `simplify` in `threeforge optimize` |
| `vatInstances` high with few submissions | the crowd is instanced | nothing: that is the goal |

The crowd benchmark (`pnpm bench`, scene `crowd`) draws 200 Kenney mini characters of eight prototypes, each
with its own clip and time offset: 401 submissions naive, 17 optimized (16 instanced part draws plus the ground),
and no skeleton bones updated on the CPU.
