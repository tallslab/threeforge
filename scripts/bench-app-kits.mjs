// What the kit-backed scenes ask for, by kit and base name: `crowd.ts` takes the eight mini characters, the rest is
// `test/app/arena.ts` (bossfight). Both throw on a name the trimmed index does not carry, so a list that falls
// behind the scenes fails the page instead of measuring a thinner scene.
export const KIT_ASSETS = {
  'kenney-mini-characters': {
    glbs: ['male-a', 'male-b', 'male-c', 'male-d', 'female-a', 'female-b', 'female-c', 'female-d'].map(
      (n) => `character-${n}`,
    ),
  },
  'kenney-mini-arena': {
    glbs: [
      'floor',
      'floor-detail',
      'wall',
      'wall-corner',
      'column',
      'statue',
      'tree',
      'banner',
      'weapon-rack',
      'trophy',
      'block',
      'weapon-sword',
      'weapon-spear',
    ],
  },
  'kenney-mini-dungeon': { glbs: ['barrel', 'chest', 'table', 'pot', 'chair', 'rocks', 'stones'] },
  'kenney-blaster-kit': { glbs: ['blaster-a', 'blaster-f'] },
  'kenney-blocky-characters': { glbs: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((n) => `character-${n}`) },
  'kenney-particle-pack': {
    textures: ['flame_01', 'spark_04', 'smoke_04', 'magic_02', 'trace_01', 'star_06', 'scorch_01', 'fire_01'],
  },
};
