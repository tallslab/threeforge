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
crowd.setMatrixAt(i, matrix);                        // the character's transform (getMatrixAt returns it)
crowd.setClipAt(i, 'walk', { offset: i * 0.13, speed: 1 });
crowd.setTime(seconds);                              // one clock for every instance, each frame
crowd.setClipAt(i, 'attack', { restart: true, fade: 0.2 }); // from its first row, blended in over 0.2 s
crowd.setClipAt(i, 'die', { once: true, restart: true });   // plays once from now, then holds the end pose
crowd.activeCount = 40;                              // draw only the first 40
const moved = crowd.removeAt(7);                     // the last active one now sits in slot 7 (-1: none moved)
```

One `Mesh` per part of the prototype over an `InstancedBufferGeometry` that shares the part's vertex buffers, with a
`MeshStandardNodeMaterial` (colour, maps and flags copied from the part's material, or from `material`), or with
`shading: 'lambert'` a `MeshLambertNodeMaterial` and with `shading: 'unlit'` a `MeshBasicNodeMaterial`, copying only
the properties that material has. Its vertex stage fetches the four bone matrices of the instance's current frame from the texture and applies three's skinning
formula, then the part's offset from the character root and the instance matrix; the fragment stage is the chosen
material's lighting. Per instance: the character's matrix (`matrixBuffer`, `getMatrixAt` returns it) and, in a second
instanced interleaved buffer (`clipBuffer`, 12 floats), `[clipStart, loopRows, timeOffset, speed]` of the clip
(`clipAttribute`), the same for the clip it fades from, `[fadeStart, fadeSeconds]`, and for both clips the last row
plus one when it plays once (0 when it loops). Both are shared by the parts,
which with the geometry's own attributes keeps a part within WebGPU's eight vertex buffers.

**Fades.** `setClipAt(i, clip, { fade })` copies the clip the instance was showing into the fade-from slot and blends
from it to the new one over `fade` seconds starting at the current `time`; both keep playing on their own clocks. The
vertex stage reads both rows and blends their skinning matrices linearly by the weight, `clamp((time - fadeStart) /
fadeSeconds, 0, 1)`, or 1 without a fade, so the texture loads per bone double for every instance whether it is fading
or not. A linear blend of skinning matrices is what vertex-animation crossfades do; it is not three's mixer, which
blends each bone's local rotation before the hierarchy, and over a long fade between very different poses limbs can
shorten. A fade started during a fade starts from the clip set last, not from the blend in progress. `restart: true`
sets the offset so the clip is on its first row at the current time (`offset` is added to that).

**Played once.** `once: true` plays the clip once and holds its end pose, as a mixer action with `LoopOnce` and
`clampWhenFinished`: before its start (an offset that puts it in the future) the instance holds the clip's first row,
from its duration on its last baked row, which `bakeAnimationTexture` stores as the clamped end pose, and in between
the same nearest-lower row a looping clip reads. The clock is the shared `time`, so a clip played once from now needs
`restart: true`; without it a clip set at 50 s with no offset is long finished. A fade out of a held clip starts from
the held pose. The clip's end is at `time + duration / speed` after a restart, for game code that switches clips
when it is over.

**Active count.** `activeCount` (0 to `count`, default `count`) is every part's `instanceCount`: only the first
`activeCount` instances are drawn, and the ledger's `vatInstances` counts those. `removeAt(i)` moves the last active
instance (matrix, clip and fade) into slot `i`, lowers the count and returns the index that moved, or -1 when `i` was
the last. At 0 three skips the draw on both backends, but each part is still a submission in the ledger and still
walked by three; hide the meshes of a pool that stays empty. `loopRows` is the clip's `duration ×
fps`: the row counter wraps where a looping mixer wraps, not at the clip's stored `frames`, which run one or two rows
past it, and a clip without duration holds its one row. A timestamp a float32 step below a loop boundary reads the
clip's last row: the remainder float32 can leave just below zero there is moved one period up. Per part: its offset,
`animation.parts[k].matrix`, as a `mat4` uniform of that part's material, read every frame, so a prototype whose parts
sit at different offsets from its root draws each part at the character matrix × its own matrix. The meshes are named
`forge:vat:<part>` and carry `userData.forge = { kind: 'vat', instances }`, which the ledger reports as reason
`vat-instanced` with `skinning.vatInstances` and `vatVertices`. Do not tag them: a tag would overwrite that marker.
Skinned parts sharing a skeleton or not both work (each part reads its own bone range).

What it does not do: blending more than two clips, root motion,
and frustum culling per instance (`frustumCulled = false`; use it for crowds that stay mostly on screen or split
large crowds by region). Three more limits predate this module and still hold:

- **The prototype must not move after baking.** Each part's `bind` / `bindInverse` uniforms wrap the prototype's
  **live** `bindMatrix` and `bindMatrixInverse`, so moving, turning or scaling the prototype after
  `bakeAnimationTexture` shifts every character drawn from it. The per-part offset is not affected: it reads the
  baked `animation.parts[k].matrix` copy, not the prototype.
- **Non-uniform scale shades wrongly.** Normals are turned by `mat3(model)`, which is correct only under a uniform
  scale.
- **Detached bind mode is not reproduced.** A part whose `SkinnedMesh` used `DetachedBindMode` draws as if it had
  been attached.

The measured overdraw (`ledger.measureOverdraw`) counts animated instances in their animated pose: its count material
is a node material, and three's override copies each material's `positionNode` onto it, so an instance covers the
pixels its current frame covers, as a skinned original at the same time does.

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
