/**
 * The ledger's lighting section through the fake renderer's model of three r186. Lights are those three projected for
 * the main pass (`lightsNode.getLights()`, renderObject's argument 7), else a walk of the main scene's world-visible
 * lights. Pass ids are `shadow:<name>` (the type for an unnamed light), `shadow:<name>#k` for lights sharing a name,
 * unique across the scenes of a frame; `shadowTexels` sums mapSize.x · mapSize.y · faces over the maps rendered this
 * frame, each light once; `shadowCasters` counts distinct objects drawn into any shadow map (a batch is one object);
 * VSM blur quads file under `shadow:<id>:vsm` as renderer-internal.
 */

import {
  AmbientLight,
  DirectionalLight,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Object3D,
  PointLight,
  Scene,
  SpotLight,
  VSMShadowMap,
} from 'three';
import { describe, expect, it } from 'vitest';
import { tag } from '../../src/tags.js';
import { batchedOf, type FakeRenderer } from './helpers/fakeRenderer.js';
import { attachedLedger } from './helpers/ledger.js';
import { box, caster, casting } from './helpers/ledgerFixtures.js';

/** Makes `render` from the object's outermost onBeforeRender (a mirror or a portal); the nested one does nothing. */
function renderFromHook(object: Object3D, render: (renderer: FakeRenderer) => void): void {
  let inside = false;
  object.onBeforeRender = ((renderer: unknown) => {
    if (inside) return;
    inside = true;
    try {
      render(renderer as FakeRenderer);
    } finally {
      inside = false;
    }
  }) as Object3D['onBeforeRender'];
}

describe('lighting section: shadow pass ids', () => {
  it('keeps shadow:<name> for a unique shadow-casting light name and numbers lights that share one shadow:<name>#k, in scene order', () => {
    const sun = casting(new DirectionalLight(), 'sun');
    // Casts no shadow, so it does not make "sun" a duplicate.
    const moon = new SpotLight();
    moon.name = 'sun';
    const lamps = [casting(new SpotLight(), 'lamp'), casting(new SpotLight(), 'lamp')];
    const unnamed = [casting(new DirectionalLight(), ''), casting(new DirectionalLight(), '')];
    const { renderer, ledger, scene, camera } = attachedLedger({ shadowLights: [sun, ...lamps, ...unnamed] });
    scene.add(sun, moon, ...lamps, ...unnamed, caster('crate'));
    renderer.render(scene, camera);
    const frame = ledger.frame();
    expect(frame.passes.map((p) => [p.id, p.submissions])).toEqual([
      ['shadow:sun', 1],
      ['shadow:lamp#1', 1],
      ['shadow:lamp#2', 1],
      ['shadow:DirectionalLight#1', 1],
      ['shadow:DirectionalLight#2', 1],
      ['main', 2],
    ]);
    expect(frame.lighting).toMatchObject({ shadowLights: 5, shadowPasses: 5, shadowSubmissions: 5, shadowCasters: 1 });
    expect(frame.totals.unattributed).toBe(0);
  });

  it("keeps ids unique across the scenes of one frame: a nested scene's light named like a main-scene light gets the next number", () => {
    const sun = casting(new DirectionalLight(), 'sun');
    const farSun = casting(new DirectionalLight(), 'sun');
    const { renderer, ledger, scene, camera } = attachedLedger({ shadowLights: [sun, farSun] });
    const far = new Scene();
    far.name = 'far';
    far.add(farSun, caster('far-crate'));
    const portal = tag.static(new Mesh(box, new MeshBasicMaterial()));
    portal.name = 'portal';
    renderFromHook(portal, (r) => r.render(far, camera));
    scene.add(sun, caster('crate'), portal);
    for (let i = 0; i < 2; i++) {
      renderer.render(scene, camera);
      const frame = ledger.frame();
      expect(frame.passes.map((p) => p.id).sort()).toEqual(['main', 'scene:far', 'shadow:sun', 'shadow:sun#2']);
      expect(frame.lighting).toMatchObject({ shadowPasses: 2, shadowCasters: 2 });
      expect(frame.totals.unattributed).toBe(0);
    }
  });
});

describe('lighting section: lights', () => {
  it('counts the lights three projected for the main pass, not every light in the graph', () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    const hidden = new Group();
    hidden.visible = false;
    hidden.add(new PointLight());
    const otherLayer = new SpotLight();
    otherLayer.layers.set(2);
    scene.add(
      new DirectionalLight(),
      new AmbientLight(),
      hidden,
      otherLayer,
      tag.static(new Mesh(box, new MeshBasicMaterial())),
    );
    renderer.render(scene, camera);
    expect(ledger.frame().lighting.lights).toEqual({
      directional: 1,
      point: 0,
      spot: 0,
      hemisphere: 0,
      ambient: 1,
      other: 0,
    });
  });

  it('without a lights node on renderObject, walks the main scene for its world-visible lights', () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    // Wraps the ledger's wrapper, so the ledger sees renderObject calls without argument 7.
    const withLights = renderer.renderObject as (...args: unknown[]) => void;
    renderer.renderObject = function (this: FakeRenderer, ...args: unknown[]) {
      args[6] = null;
      withLights.apply(this, args);
    } as FakeRenderer['renderObject'];
    const hidden = new Group();
    hidden.visible = false;
    hidden.add(new PointLight());
    // The walk has no camera: a light on another layer counts.
    const otherLayer = new SpotLight();
    otherLayer.layers.set(2);
    scene.add(new DirectionalLight(), hidden, otherLayer, tag.static(new Mesh(box, new MeshBasicMaterial())));
    renderer.render(scene, camera);
    expect(ledger.frame().lighting.lights).toEqual({
      directional: 1,
      point: 0,
      spot: 1,
      hemisphere: 0,
      ambient: 0,
      other: 0,
    });
  });

  it('without a lights node, a frame whose outermost render is an override scene reports only the main scene’s lights, not both scenes’', () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    const withLights = renderer.renderObject as (...args: unknown[]) => void;
    renderer.renderObject = function (this: FakeRenderer, ...args: unknown[]) {
      args[6] = null;
      withLights.apply(this, args);
    } as FakeRenderer['renderObject'];
    // The outermost render draws `scene` under an override material (pass `override`): no main scene yet.
    scene.overrideMaterial = new MeshBasicMaterial();
    const trigger = tag.static(new Mesh(box, new MeshBasicMaterial()));
    scene.add(new DirectionalLight(), new AmbientLight(), trigger);
    // Its draw renders a second, plain scene: the frame's first scene render without an override, so its main pass.
    const room = new Scene();
    room.add(new PointLight(), tag.static(new Mesh(box, new MeshBasicMaterial())));
    renderFromHook(trigger, (r) => r.render(room, camera));
    renderer.render(scene, camera);
    const frame = ledger.frame();
    expect(frame.passes.map((p) => p.id)).toEqual(['main', 'override']);
    expect(frame.lighting.lights).toEqual({ directional: 0, point: 1, spot: 0, hemisphere: 0, ambient: 0, other: 0 });
  });

  it("does not read the output quad's lights node: a main pass that draws only the quad reports the scene's lights", () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    scene.add(new DirectionalLight(), new AmbientLight());
    renderer.render(scene, camera);
    expect(ledger.frame().lighting.lights).toMatchObject({ directional: 1, ambient: 1 });
  });
});

describe('lighting section: shadow texels', () => {
  it('counts only the maps rendered this frame: a frozen map on the frames it refreshes, a disabled shadow map never', () => {
    const sun = casting(new DirectionalLight(), 'sun', 1024);
    const spot = casting(new SpotLight(), 'spot', 512);
    spot.shadow.autoUpdate = false;
    spot.shadow.needsUpdate = true;
    const { renderer, ledger, scene, camera } = attachedLedger({ shadowLights: [sun, spot] });
    scene.add(sun, spot, caster('crate'));
    const texels = (): number => {
      renderer.render(scene, camera);
      return ledger.frame().lighting.shadowTexels;
    };
    expect(texels(), 'first frame: the frozen map renders once').toBe(1024 * 1024 + 512 * 512);
    expect(texels(), 'frozen').toBe(1024 * 1024);
    spot.shadow.needsUpdate = true;
    expect(texels(), 'refreshed').toBe(1024 * 1024 + 512 * 512);
    renderer.shadowMap.enabled = false;
    expect(texels(), 'shadow map disabled').toBe(0);
    expect(ledger.frame().lighting).toMatchObject({ shadowLights: 2, shadowPasses: 0, shadowCasters: 0 });
  });

  it("counts a point light's six faces, and a map rendered again for a second camera in the same frame once", () => {
    const lamp = casting(new PointLight(), 'lamp', 256);
    const sun = casting(new DirectionalLight(), 'sun', 1024);
    const { renderer, ledger, scene, camera } = attachedLedger({ shadowLights: [lamp, sun], record: true });
    const mirrorCamera = camera.clone();
    const mirror = tag.static(new Mesh(box, new MeshBasicMaterial()));
    mirror.name = 'mirror';
    renderFromHook(mirror, (r) => r.render(scene, mirrorCamera));
    scene.add(lamp, sun, caster('crate'), mirror);
    renderer.render(scene, camera);
    // ShadowNode keys its once-per-frame check by camera, so both maps render for each camera: 7 renders twice.
    expect(renderer.passes.filter((p) => p.kind === 'shadow')).toHaveLength(14);
    expect(ledger.frame().lighting).toMatchObject({
      shadowTexels: 256 * 256 * 6 + 1024 * 1024,
      shadowCasters: 1,
      shadowPasses: 2,
    });
  });

  it('sizes a point light by its map width on every face: three renders each cube face at mapSize.width squared', () => {
    // PointShadowNode allocates the cube target at `shadow.mapSize.width` and renders each face at that size
    // (node_modules/three/src/nodes/lighting/PointShadowNode.js:227 and :254): the height is never read.
    const lamp = casting(new PointLight(), 'lamp', 256);
    lamp.shadow.mapSize.set(256, 64);
    const { renderer, ledger, scene, camera } = attachedLedger({ shadowLights: [lamp] });
    scene.add(lamp, caster('crate'));
    renderer.render(scene, camera);
    expect(ledger.frame().lighting.shadowTexels).toBe(256 * 256 * 6);
  });
});

describe('lighting section: shadow casters', () => {
  it('counts casters per object: same-named casters apart, an object once across a point light and a sun, a batch once', () => {
    const lamp = casting(new PointLight(), 'lamp', 256);
    const sun = casting(new DirectionalLight(), 'sun');
    const { renderer, ledger, scene, camera } = attachedLedger({ shadowLights: [lamp, sun] });
    // Two unnamed casters with the same path, car/Mesh[0].
    const cars = ['car', 'car'].map((name) => {
      const group = new Group();
      group.name = name;
      group.add(caster(''));
      return group;
    });
    const batch = batchedOf(5, new MeshStandardMaterial(), box);
    batch.castShadow = true;
    scene.add(lamp, sun, caster('crate'), caster('crate'), ...cars, batch);
    renderer.render(scene, camera);
    const frame = ledger.frame();
    // crate, crate, two car/Mesh[0] and the batch: 5 objects, each drawn into 6 lamp faces and the sun's map.
    expect(frame.lighting).toMatchObject({ shadowCasters: 5, shadowSubmissions: 5 * 7, shadowPasses: 2 });
    expect(frame.totals.unattributed).toBe(0);
  });
});

describe('lighting section: overdraw count renders', () => {
  it('a measurement from a shadow caster’s hook adds no pass, light, caster or texel to the frame around it', async () => {
    const sun = casting(new DirectionalLight(), 'sun', 1024);
    const { renderer, ledger, scene, camera } = attachedLedger({ shadowLights: [sun] });
    const crate = caster('crate');
    scene.add(sun, crate);
    renderer.render(scene, camera);
    const plain = ledger.frame();
    let pending: Promise<unknown> | null = null;
    let started = false;
    crate.onBeforeRender = () => {
      // Measure once: the count render draws the crate and calls this hook again.
      if (started) return;
      started = true;
      pending = ledger.measureOverdraw(scene, camera);
    };
    renderer.render(scene, camera);
    const hooked = ledger.frame();
    crate.onBeforeRender = () => {};
    expect(pending).not.toBeNull();
    await pending;
    expect(hooked.passes).toEqual(plain.passes);
    expect(hooked.lighting).toEqual(plain.lighting);
    expect(hooked.totals).toEqual(plain.totals);
  });
});

describe('lighting section: VSM blur quads', () => {
  it('files the blur quads after each non-point map into shadow:<id>:vsm as renderer-internal, outside scene submissions, shadow passes, casters and texels', () => {
    const sun = casting(new DirectionalLight(), 'sun', 1024);
    const lamp = casting(new PointLight(), 'lamp', 256);
    const { renderer, ledger, scene, camera } = attachedLedger({ shadowLights: [sun, lamp], vsmQuad: true });
    renderer.shadowMap.type = VSMShadowMap;
    scene.add(sun, lamp, caster('crate'));
    renderer.render(scene, camera);
    const frame = ledger.frame();
    expect(frame.passes.map((p) => [p.id, p.submissions])).toEqual([
      ['shadow:sun', 1],
      ['shadow:sun:vsm', 2],
      ['shadow:lamp', 6],
      ['main', 2],
    ]);
    // The two blur quads and the output quad.
    expect(frame.byReason['renderer-internal']?.submissions).toBe(3);
    expect(frame.byReason['fullscreen-pass']).toBeUndefined();
    expect(frame.totals).toMatchObject({ sceneSubmissions: 1 + 6 + 1, unattributed: 0 });
    expect(frame.lighting).toMatchObject({
      shadowPasses: 2,
      shadowSubmissions: 7,
      shadowCasters: 1,
      shadowTexels: 1024 * 1024 + 256 * 256 * 6,
    });
  });
});
