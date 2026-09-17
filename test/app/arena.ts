/**
 * A fight arena assembled from CC0 game packs: Kenney mini characters (skinned, combat clips with crossfades),
 * blocky characters (rigid node-animated hierarchies), weapons attached to hand bones, arena and dungeon props,
 * shadowed spot and point lights, and VFX: additive particle systems, sprites, a sword trail with dynamic
 * geometry, floor decals and a flipbook. Deterministic: animations are posed by time, particles by seed + time.
 */
import {
  AdditiveBlending,
  AmbientLight,
  AnimationClip,
  AnimationMixer,
  type Bone,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Euler,
  Float32BufferAttribute,
  type Group,
  HemisphereLight,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Object3D,
  PlaneGeometry,
  PointLight,
  Points,
  PointsMaterial,
  Scene,
  SpotLight,
  Sprite,
  SpriteMaterial,
  type Texture,
  TextureLoader,
  Vector3,
} from 'three';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { assembleCharacter, disposeLoader, tag } from 'threeforge';
import { mulberry32 } from '../scenes/naive.js';
import { applyRoomEnvironment } from './scenes/environment.js';
import type { BenchBuilder } from './scenes/index.js';

export interface ArenaOptions {
  loader: GLTFLoader;
  fighters?: number;
  blocky?: number;
  seed?: number;
  vfx?: boolean;
  /** Particle systems to build (the first six are the arena's own: four smoke columns, sparks, magic). */
  effects?: number;
  shadows?: boolean;
  /** Merge each fighter's skinned parts (body + head) into one skinned mesh with one atlas. */
  assemble?: boolean;
}

export interface Arena {
  scene: Scene;
  /** Clips per animated root, for `World({ animations })`. */
  animations: Array<{ root: Object3D; clips: AnimationClip[] }>;
  mixers: AnimationMixer[];
  /** Advance every animation, particle system and effect to time `t` seconds (deterministic). */
  setTime(t: number): void;
  counts: Record<string, number>;
  lights: { spots: SpotLight[]; points: PointLight[] };
}

interface KitIndex {
  name: string;
  kind?: string;
  glbs?: string[];
  textures?: string[];
  error?: string;
}

export async function buildArena({
  loader,
  fighters = 12,
  blocky = 16,
  seed = 21,
  vfx = true,
  effects = 6,
  shadows = true,
  assemble = false,
}: ArenaOptions): Promise<Arena> {
  const rng = mulberry32(seed);
  const scene = new Scene();
  scene.name = 'arena';
  scene.background = new Color(0x0b0d14);
  const counts: Record<string, number> = {};
  const lists = (
    await Promise.all(
      ['/kits-index.json'].map((u) =>
        fetch(u)
          .then((r) => (r.ok ? r.json() : []))
          .catch(() => []),
      ),
    )
  ).flat() as KitIndex[];
  const kit = (name: string) => lists.find((k) => k.name === name && !k.error);
  const glb = (kitName: string, base: string) =>
    kit(kitName)?.glbs?.find((g) => g.toLowerCase().endsWith(`/${base}.glb`));
  const tex = (kitName: string, base: string) =>
    kit(kitName)?.textures?.find(
      (t) => t.toLowerCase().endsWith(`/${base}.png`) || t.toLowerCase().endsWith(`/${base}.jpg`),
    );
  const cache = new Map<string, { scene: Group; animations: AnimationClip[] }>();
  const load = async (path: string | undefined) => {
    if (!path) return null;
    if (!cache.has(path)) {
      const gltf = await loader.loadAsync('/' + path);
      cache.set(path, { scene: gltf.scene, animations: gltf.animations });
    }
    return cache.get(path)!;
  };
  const textureLoader = new TextureLoader();
  const loadTexture = async (path: string | undefined): Promise<Texture | null> =>
    path ? textureLoader.loadAsync('/' + path) : null;
  const tagAll = (root: Object3D, kind: 'static' | 'dynamic') =>
    root.traverse((o) => {
      if ((o as Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        if (kind === 'static') tag.static(o);
        else tag.dynamic(o);
      }
    });
  const placeStatic = (proto: Group, x: number, z: number, rot = 0, scale = 1, y = 0): Object3D => {
    const c = proto.clone();
    c.position.set(x, y, z);
    c.rotation.y = rot;
    c.scale.setScalar(scale);
    tagAll(c, 'static');
    scene.add(c);
    return c;
  };

  // ---- Environment: floor grid, walls with columns, props ----
  const S = 4; // tile size in world units after scaling
  const half = 10;
  const floor = await load(glb('kenney-mini-arena', 'floor'));
  const floorDetail = await load(glb('kenney-mini-arena', 'floor-detail'));
  const wall = await load(glb('kenney-mini-arena', 'wall'));
  const corner = await load(glb('kenney-mini-arena', 'wall-corner'));
  const column = await load(glb('kenney-mini-arena', 'column'));
  const decor = (
    await Promise.all(
      ['statue', 'tree', 'banner', 'weapon-rack', 'trophy', 'block'].map((n) => load(glb('kenney-mini-arena', n))),
    )
  ).filter((x): x is NonNullable<typeof x> => x !== null);
  const dungeon = (
    await Promise.all(
      ['barrel', 'chest', 'table', 'pot', 'chair', 'rocks', 'stones'].map((n) => load(glb('kenney-mini-dungeon', n))),
    )
  ).filter((x): x is NonNullable<typeof x> => x !== null);
  let tiles = 0;
  for (let i = -half; i < half; i++) {
    for (let j = -half; j < half; j++) {
      const proto = (i + j) % 5 === 0 && floorDetail ? floorDetail : floor;
      if (!proto) continue;
      placeStatic(proto.scene, i * S + S / 2, j * S + S / 2, 0, S);
      tiles++;
    }
  }
  let walls = 0;
  for (let i = -half; i < half; i++) {
    for (const [x, z, rot] of [
      [i * S + S / 2, -half * S, 0],
      [i * S + S / 2, half * S, Math.PI],
      [-half * S, i * S + S / 2, Math.PI / 2],
      [half * S, i * S + S / 2, -Math.PI / 2],
    ] as Array<[number, number, number]>) {
      const proto = i % 4 === 0 && column ? column : wall;
      if (!proto) continue;
      placeStatic(proto.scene, x, z, rot, S);
      walls++;
    }
  }
  if (corner)
    for (const [x, z, r] of [
      [-half * S, -half * S, 0],
      [half * S, -half * S, -Math.PI / 2],
      [half * S, half * S, Math.PI],
      [-half * S, half * S, Math.PI / 2],
    ] as Array<[number, number, number]>)
      placeStatic(corner.scene, x, z, r, S);
  let props = 0;
  for (let i = 0; i < 40; i++) {
    const proto = i % 2 ? decor[Math.floor(rng() * decor.length)] : dungeon[Math.floor(rng() * dungeon.length)];
    if (!proto) continue;
    const r = 26 + rng() * 10;
    const a = rng() * Math.PI * 2;
    placeStatic(proto.scene, Math.cos(a) * r, Math.sin(a) * r, rng() * Math.PI * 2, S * (0.8 + rng() * 0.6));
    props++;
  }
  counts.tiles = tiles;
  counts.walls = walls;
  counts.props = props;

  // ---- Fighters: skinned mini characters with combat clips and crossfades, weapons on hand bones ----
  const animations: Arena['animations'] = [];
  const mixers: AnimationMixer[] = [];
  const fades: Array<{ mixer: AnimationMixer; from: string; to: string; at: number }> = [];
  const combat = [
    'attack-melee-right',
    'attack-melee-left',
    'attack-kick-right',
    'attack-kick-left',
    'holding-right-shoot',
    'idle',
    'walk',
    'sprint',
  ];
  const characterNames = [
    'character-male-a',
    'character-male-b',
    'character-male-c',
    'character-female-a',
    'character-female-b',
    'character-female-c',
    'character-male-d',
    'character-female-d',
  ];
  const weapons = (
    await Promise.all(
      [
        glb('kenney-mini-arena', 'weapon-sword'),
        glb('kenney-mini-arena', 'weapon-spear'),
        glb('kenney-blaster-kit', 'blaster-a'),
        glb('kenney-blaster-kit', 'blaster-f'),
      ].map(load),
    )
  ).filter((x): x is NonNullable<typeof x> => x !== null);
  let fighterCount = 0;
  for (let i = 0; i < fighters; i++) {
    const proto = await load(glb('kenney-mini-characters', characterNames[i % characterNames.length]!));
    if (!proto) continue;
    const SkeletonUtils = await import('three/addons/utils/SkeletonUtils.js');
    const fighter = SkeletonUtils.clone(proto.scene) as Group;
    fighter.name = `fighter-${i}`;
    const a = (i / fighters) * Math.PI * 2;
    const r = 8 + (i % 3) * 5;
    fighter.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    fighter.rotation.y = -a + Math.PI / 2;
    fighter.scale.setScalar(S * 0.9);
    fighter.traverse((o) => {
      if ((o as Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    scene.add(fighter);
    if (assemble) {
      const parts: import('three').SkinnedMesh[] = [];
      fighter.traverse((o) => {
        if ((o as import('three').SkinnedMesh).isSkinnedMesh) parts.push(o as import('three').SkinnedMesh);
      });
      if (parts.length > 1) {
        const assembled = assembleCharacter({
          skeleton: parts[0]!.skeleton,
          wardrobe: parts,
          equipped: parts,
          atlas: { size: 256 },
        });
        assembled.mesh.castShadow = true;
        assembled.mesh.receiveShadow = true;
        for (const part of parts) part.parent?.remove(part);
        parts[0]!.parent === null ? fighter.add(assembled.mesh) : fighter.add(assembled.mesh);
        counts.assembled = (counts.assembled ?? 0) + 1;
      }
    }
    const mixer = new AnimationMixer(fighter);
    const clipA = AnimationClip.findByName(proto.animations, combat[i % combat.length]!) ?? proto.animations[0]!;
    const clipB = AnimationClip.findByName(proto.animations, combat[(i + 3) % combat.length]!) ?? proto.animations[1]!;
    const actionA = mixer.clipAction(clipA);
    const actionB = mixer.clipAction(clipB);
    actionA.play();
    actionB.play();
    actionB.setEffectiveWeight(0);
    fades.push({ mixer, from: clipA.name, to: clipB.name, at: 0.8 + (i % 4) * 0.3 });
    mixers.push(mixer);
    animations.push({ root: fighter, clips: proto.animations });
    // Weapon in the right hand: a plain mesh parented under a bone.
    let hand: Bone | null = null;
    fighter.traverse((o) => {
      if ((o as Bone).isBone && /arm-right|hand-right|arm_right/i.test(o.name) && !hand) hand = o as Bone;
    });
    if (!hand)
      fighter.traverse((o) => {
        if ((o as Bone).isBone && !hand) hand = o as Bone;
      });
    const weapon = weapons[i % weapons.length];
    if (hand && weapon) {
      const w = weapon.scene.clone();
      w.name = `weapon-${i}`;
      w.position.set(0, 0.35, 0.1);
      w.rotation.set(Math.PI / 2, 0, 0);
      w.scale.setScalar(0.9);
      w.traverse((o) => {
        if ((o as Mesh).isMesh) o.castShadow = true;
      });
      (hand as Bone).add(w);
    }
    fighterCount++;
  }
  counts.fighters = fighterCount;

  // ---- Blocky characters: rigid hierarchies driven by node animation ----
  let blockyCount = 0;
  const blockyNames = [
    'character-a',
    'character-b',
    'character-c',
    'character-d',
    'character-e',
    'character-f',
    'character-g',
    'character-h',
  ];
  for (let i = 0; i < blocky; i++) {
    const proto = await load(glb('kenney-blocky-characters', blockyNames[i % blockyNames.length]!));
    if (!proto) continue;
    const c = proto.scene.clone();
    c.name = `blocky-${i}`;
    const a = (i / blocky) * Math.PI * 2 + 0.2;
    const r = 20 + (i % 2) * 4;
    c.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    c.rotation.y = -a - Math.PI / 2;
    c.scale.setScalar(S * 0.9);
    c.traverse((o) => {
      if ((o as Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    scene.add(c);
    const mixer = new AnimationMixer(c);
    const clip = AnimationClip.findByName(proto.animations, combat[(i + 1) % combat.length]!) ?? proto.animations[0]!;
    mixer.clipAction(clip).play();
    mixers.push(mixer);
    animations.push({ root: c, clips: proto.animations });
    blockyCount++;
  }
  counts.blocky = blockyCount;

  // ---- Lighting: shadowed spots, a shadowed point light, torch point lights ----
  const spots: SpotLight[] = [];
  const points: PointLight[] = [];
  scene.add(new HemisphereLight(0x8090b0, 0x202020, 0.25), new AmbientLight(0xffffff, 0.08));
  for (const [x, z, name] of [
    [-30, -30, 'spot-1'],
    [30, 30, 'spot-2'],
  ] as Array<[number, number, string]>) {
    const spot = new SpotLight(0xfff0d0, 900, 140, Math.PI / 5, 0.4, 1.2);
    spot.name = name;
    spot.position.set(x, 45, z);
    spot.target.position.set(0, 0, 0);
    spot.castShadow = shadows;
    spot.shadow.mapSize.set(1024, 1024);
    spot.shadow.camera.near = 5;
    spot.shadow.camera.far = 150;
    scene.add(spot, spot.target);
    spots.push(spot);
  }
  const torchTex = await loadTexture(tex('kenney-particle-pack', 'flame_01'));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const light = new PointLight(i === 0 ? 0xff8040 : 0xff9a50, 60, 60, 1.5);
    light.name = `point-${i + 1}`;
    light.position.set(Math.cos(a) * 30, 8, Math.sin(a) * 30);
    light.castShadow = shadows && i === 0; // one point light with cube shadows
    light.shadow.mapSize.set(512, 512);
    scene.add(light);
    points.push(light);
    // Emissive torch head so bloom has something to grab.
    const head = new Mesh(
      new PlaneGeometry(2, 3),
      new MeshBasicMaterial({
        map: torchTex ?? undefined,
        color: 0xffa040,
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        side: DoubleSide,
      }),
    );
    head.name = `torch-${i + 1}`;
    head.position.copy(light.position);
    tag.dynamic(head); // billboarded by hand each frame
    scene.add(head);
  }

  // ---- VFX ----
  const particleSystems: Array<{ points: Points; base: Float32Array; speed: number; height: number }> = [];
  const sprites: Sprite[] = [];
  let trail: Mesh | null = null;
  let flip: { mesh: Mesh; texture: Texture } | null = null;
  if (vfx) {
    const sparkTex = await loadTexture(tex('kenney-particle-pack', 'spark_04'));
    const smokeTex = await loadTexture(tex('kenney-particle-pack', 'smoke_04'));
    const magicTex = await loadTexture(tex('kenney-particle-pack', 'magic_02'));
    const makeParticles = (
      name: string,
      n: number,
      texture: Texture | null,
      color: number,
      size: number,
      center: Vector3,
      spread: number,
      height: number,
      speed: number,
    ) => {
      const base = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        base[i * 3] = center.x + (rng() - 0.5) * spread;
        base[i * 3 + 1] = center.y + rng() * height;
        base[i * 3 + 2] = center.z + (rng() - 0.5) * spread;
      }
      const geometry = new BufferGeometry();
      const position = new Float32BufferAttribute(base.slice(), 3);
      position.setUsage(DynamicDrawUsage);
      geometry.setAttribute('position', position);
      const material = new PointsMaterial({
        size,
        map: texture ?? undefined,
        color,
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      });
      const p = new Points(geometry, material);
      p.name = name;
      p.frustumCulled = false;
      scene.add(p);
      particleSystems.push({ points: p, base, speed, height });
    };
    for (let i = 0; i < 4; i++) {
      const light = points[i]!;
      makeParticles(
        `smoke-${i + 1}`,
        400,
        smokeTex,
        0x777777,
        3,
        light.position.clone().add(new Vector3(0, 2, 0)),
        3,
        14,
        1.5,
      );
    }
    makeParticles('sparks', 1500, sparkTex, 0xffcc66, 1.2, new Vector3(0, 1, 0), 40, 6, 6);
    makeParticles('magic', 800, magicTex, 0x66aaff, 2, new Vector3(0, 0.5, 0), 16, 8, 2);
    let particles = 2700 + 1600;
    // Extra simultaneous effects (the boss-fight benchmark asks for 30): bursts scattered around the arena.
    const extraTextures = [sparkTex, magicTex, smokeTex];
    const extraColors = [0xff8844, 0x88ddff, 0xaaaaaa];
    for (let i = 6; i < effects; i++) {
      const k = i % 3;
      const a = (i / Math.max(1, effects - 6)) * Math.PI * 2;
      const r = 6 + (i % 5) * 4;
      makeParticles(
        `effect-${i}`,
        150,
        extraTextures[k]!,
        extraColors[k]!,
        1.5 + k * 0.6,
        new Vector3(Math.cos(a) * r, 0.5, Math.sin(a) * r),
        4,
        5,
        2 + k,
      );
      particles += 150;
    }
    counts.particles = particles;
    counts.effects = Math.max(6, effects);

    // Sprites: health bars and damage numbers above fighters.
    const barTex = await loadTexture(tex('kenney-particle-pack', 'trace_01'));
    const starTex = await loadTexture(tex('kenney-particle-pack', 'star_06'));
    scene.traverse((o) => {
      if (/^fighter-|^blocky-/.test(o.name) && o.parent === scene) {
        const bar = new Sprite(
          new SpriteMaterial({ map: barTex ?? undefined, color: 0x40ff60, transparent: true, depthWrite: false }),
        );
        bar.name = `health-${o.name}`;
        bar.position.set(0, 2.2, 0);
        bar.scale.set(1.2, 0.2, 1);
        o.add(bar);
        const hit = new Sprite(
          new SpriteMaterial({
            map: starTex ?? undefined,
            color: 0xff4040,
            transparent: true,
            depthWrite: false,
            blending: AdditiveBlending,
          }),
        );
        hit.name = `hit-${o.name}`;
        hit.position.set(0.4, 1.6, 0);
        hit.scale.set(0.6, 0.6, 1);
        o.add(hit);
        sprites.push(bar, hit);
      }
    });
    counts.sprites = sprites.length;

    // Sword trail: a ribbon whose vertices are rewritten every frame (dynamic geometry, not batchable).
    const trailGeometry = new BufferGeometry();
    const segments = 24;
    const trailPos = new Float32BufferAttribute(new Float32Array(segments * 2 * 3), 3);
    trailPos.setUsage(DynamicDrawUsage);
    trailGeometry.setAttribute('position', trailPos);
    const idx: number[] = [];
    for (let i = 0; i < segments - 1; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    trailGeometry.setIndex(idx);
    trail = new Mesh(
      trailGeometry,
      new MeshBasicMaterial({
        color: 0x80c0ff,
        transparent: true,
        opacity: 0.6,
        blending: AdditiveBlending,
        side: DoubleSide,
        depthWrite: false,
      }),
    );
    trail.name = 'sword-trail';
    trail.frustumCulled = false;
    scene.add(trail); // deliberately untagged: the dynamic-geometry rule must catch it

    // Floor decals: scorch marks projected onto the floor tiles (unique geometries, one shared material).
    const scorchTex = await loadTexture(tex('kenney-particle-pack', 'scorch_01'));
    const decalMaterial = new MeshStandardMaterial({
      map: scorchTex ?? undefined,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      roughness: 1,
      metalness: 0,
    });
    const floorMeshes: Mesh[] = [];
    scene.traverse((o) => {
      if ((o as Mesh).isMesh && (o.parent?.name ?? '').startsWith('floor')) floorMeshes.push(o as Mesh);
    });
    let decals = 0;
    for (let i = 0; i < 30 && floorMeshes.length > 0; i++) {
      const target = floorMeshes[Math.floor(rng() * floorMeshes.length)]!;
      const pos = new Vector3().setFromMatrixPosition(target.matrixWorld);
      const geometry = new DecalGeometry(
        target,
        pos.add(new Vector3(0, 0.05, 0)),
        new Euler(-Math.PI / 2, 0, rng() * Math.PI),
        new Vector3(3 + rng() * 3, 3 + rng() * 3, 2),
      );
      const decal = new Mesh(geometry, decalMaterial);
      decal.name = `scorch-${i}`;
      tag.static(decal);
      scene.add(decal);
      decals++;
    }
    counts.decals = decals;

    // Flipbook explosion: a quad whose texture window and opacity change with time.
    const flipTex = await loadTexture(tex('kenney-particle-pack', 'fire_01'));
    if (flipTex) {
      flipTex.repeat.set(0.5, 0.5);
      const mesh = new Mesh(
        new PlaneGeometry(6, 6),
        new MeshBasicMaterial({
          map: flipTex,
          transparent: true,
          blending: AdditiveBlending,
          depthWrite: false,
          side: DoubleSide,
        }),
      );
      mesh.name = 'explosion';
      mesh.position.set(6, 3, -6);
      tag.dynamic(mesh); // material uniforms animate: tagged dynamic
      scene.add(mesh);
      flip = { mesh, texture: flipTex };
    }
  }

  const setTime = (t: number): void => {
    for (const m of mixers) m.setTime(t);
    for (const f of fades) {
      const k = Math.min(1, Math.max(0, (t - f.at) / 0.4));
      const a = f.mixer.existingAction(
        AnimationClip.findByName(
          (f.mixer.getRoot() as Object3D & { animations?: AnimationClip[] }).animations ?? [],
          f.from,
        ) ?? (f.mixer as unknown as { _actions: { _clip: AnimationClip }[] })._actions[0]!._clip,
      );
      void a;
      const actions = (
        f.mixer as unknown as { _actions: Array<{ _clip: AnimationClip; setEffectiveWeight(w: number): void }> }
      )._actions;
      for (const action of actions)
        action.setEffectiveWeight(action._clip.name === f.to ? k : action._clip.name === f.from ? 1 - k : 0);
    }
    for (const m of mixers) m.setTime(t); // re-pose with the new weights
    for (const ps of particleSystems) {
      const pos = ps.points.geometry.attributes.position as Float32BufferAttribute;
      const arr = pos.array as Float32Array;
      for (let i = 0; i < arr.length; i += 3) {
        arr[i] = ps.base[i]! + Math.sin(t * 1.3 + i) * 0.4;
        arr[i + 1] = ps.base[i + 1]! + ((t * ps.speed + i * 0.01) % ps.height);
        arr[i + 2] = ps.base[i + 2]! + Math.cos(t * 1.1 + i) * 0.4;
      }
      pos.needsUpdate = true;
    }
    for (const s of sprites)
      if (s.name.startsWith('hit-')) s.scale.setScalar(0.4 + 0.4 * Math.abs(Math.sin(t * 5 + s.position.x)));
    if (trail) {
      const pos = trail.geometry.attributes.position as Float32BufferAttribute;
      const arr = pos.array as Float32Array;
      const segments = arr.length / 6;
      for (let i = 0; i < segments; i++) {
        const a = t * 4 - i * 0.12;
        const x = Math.cos(a) * 6;
        const z = Math.sin(a) * 6;
        arr[i * 6] = x;
        arr[i * 6 + 1] = 2 + Math.sin(a * 2) * 0.5;
        arr[i * 6 + 2] = z;
        arr[i * 6 + 3] = x * 0.9;
        arr[i * 6 + 4] = 3.5 + Math.sin(a * 2) * 0.5;
        arr[i * 6 + 5] = z * 0.9;
      }
      pos.needsUpdate = true;
    }
    if (flip) {
      const frame = Math.floor(t * 12) % 4;
      flip.texture.offset.set((frame % 2) * 0.5, Math.floor(frame / 2) * 0.5);
      (flip.mesh.material as Material).opacity = 0.5 + 0.5 * Math.abs(Math.sin(t * 3));
    }
    for (let i = 0; i < points.length; i++) points[i]!.intensity = 60 + Math.sin(t * 9 + i) * 12;
  };
  setTime(0);
  return { scene, animations, mixers, setTime, counts, lights: { spots, points } };
}

/** The harness's `scene=arena`: `fighters`, `blocky`, `vfx`, `shadows`, `assemble`, `env` and `t` query params. */
export const arenaScene: BenchBuilder = async ({ renderer, camera, params, loader: makeLoader }) => {
  const loader = await makeLoader();
  if (params.get('shadows') !== '0') renderer.shadowMap.enabled = true;
  const arena = await buildArena({
    loader,
    fighters: Number(params.get('fighters') ?? '12'),
    blocky: Number(params.get('blocky') ?? '16'),
    vfx: params.get('vfx') !== '0',
    shadows: params.get('shadows') !== '0',
    assemble: params.get('assemble') === '1',
  });
  disposeLoader(loader);
  const { scene } = arena;
  if (params.get('env') !== '0') applyRoomEnvironment(renderer, scene, 0.15);
  camera.near = 0.5;
  camera.far = 400;
  camera.position.set(-38, 34, 58);
  camera.lookAt(0, 3, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  arena.setTime(Number(params.get('t') ?? '1'));
  return {
    scene,
    counts: arena.counts,
    arena,
    animations: arena.animations,
    setTime: arena.setTime,
  };
};
