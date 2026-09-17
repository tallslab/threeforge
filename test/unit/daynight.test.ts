import { BackSide, type BufferAttribute, Color, Fog, type Mesh, type MeshBasicMaterial, Scene, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { DayNight } from '../../src/lighting/DayNight.js';
import { tag } from '../../src/tags.js';

function setup(everyDegrees = 1) {
  const scene = new Scene();
  scene.fog = new Fog(0x123456, 10, 100);
  scene.background = new Color(0x654321);
  const dn = new DayNight(scene, { shadow: { everyDegrees } });
  return { scene, dn };
}
const domeColors = (dome: Mesh): number[] => Array.from(dome.geometry.getAttribute('color').array as Float32Array);
/** The direction the sun shades from: its world position relative to its target's. */
const sunDirection = (dn: DayNight): Vector3 =>
  dn.sun.getWorldPosition(new Vector3()).sub(dn.sun.target.getWorldPosition(new Vector3())).normalize();

describe('DayNight', () => {
  it('adds a sun with its target, a static gradient dome and a hemisphere light', () => {
    const { scene, dn } = setup();
    expect(scene.children).toContain(dn.sun);
    expect(scene.children).toContain(dn.sun.target);
    expect(scene.children).toContain(dn.dome);
    expect(scene.children).toContain(dn.hemisphere);
    const dome = dn.dome!;
    expect(dome.name).toBe('sky-dome');
    expect(tag.of(dome)).toBe('static');
    const material = dome.material as MeshBasicMaterial;
    expect(material.side).toBe(BackSide);
    expect(material.vertexColors).toBe(true);
    expect(material.fog).toBe(false);
    expect(material.depthWrite).toBe(false);
  });

  it('places the sun by the hour and shades the scene from its elevation', () => {
    const { scene, dn } = setup();
    dn.setTime(12);
    expect(dn.elevation).toBeCloseTo(1, 5);
    expect(dn.sun.position.y).toBeGreaterThan(150);
    expect(dn.sun.intensity).toBeCloseTo(3, 5);
    expect(dn.sun.color.r).toBeGreaterThan(0.9);
    const noon = domeColors(dn.dome!);
    dn.setTime(6);
    expect(Math.abs(dn.elevation)).toBeLessThan(1e-6);
    expect(dn.sun.intensity).toBeLessThan(0.5);
    expect(dn.sun.color.r).toBeGreaterThan(dn.sun.color.b);
    dn.setTime(0);
    expect(dn.elevation).toBeCloseTo(-1, 5);
    expect(dn.sun.intensity).toBeGreaterThanOrEqual(0.05);
    expect(dn.sun.intensity).toBeLessThan(0.3);
    const night = domeColors(dn.dome!);
    expect(night).not.toEqual(noon);
    expect((scene.fog as Fog).color.getHex()).toBe((scene.background as Color).getHex());
    expect(dn.hemisphere!.color.getHex()).not.toBe(0);
    expect(dn.time).toBe(0);
  });

  it('re-renders the shadow map only when the sun moved past everyDegrees, or on refreshShadow()', () => {
    const { dn } = setup(1);
    expect(dn.sun.castShadow).toBe(true);
    expect(dn.sun.shadow.autoUpdate).toBe(false);
    expect(dn.sun.shadow.needsUpdate).toBe(true);
    dn.setTime(12);
    dn.sun.shadow.needsUpdate = false; // the renderer consumed it
    dn.setTime(12.05); // 0.75°
    expect(dn.sun.shadow.needsUpdate).toBe(false);
    dn.setTime(12.1); // 1.5° since the last shadow render
    expect(dn.sun.shadow.needsUpdate).toBe(true);
    dn.sun.shadow.needsUpdate = false;
    dn.refreshShadow();
    expect(dn.sun.shadow.needsUpdate).toBe(true);
    const every = new DayNight(new Scene(), { shadow: { everyDegrees: 0 } });
    expect(every.sun.shadow.autoUpdate).toBe(true);
  });

  it('skips the dome write when the sky colours are unchanged, still moving the sun', () => {
    // Day and night share one palette, so every setTime computes the same zenith and horizon whatever the hour.
    const flat = { dayZenith: 0x336699, nightZenith: 0x336699, dayHorizon: 0x99bbdd, nightHorizon: 0x99bbdd };
    const scene = new Scene();
    const dn = new DayNight(scene, { shadow: false, colors: flat });
    const attribute = dn.dome!.geometry.getAttribute('color') as BufferAttribute;
    const written = domeColors(dn.dome!);
    const version = attribute.version;
    dn.setTime(3);
    const night = {
      position: dn.sun.position.clone(),
      direction: sunDirection(dn),
      intensity: dn.sun.intensity,
      color: dn.sun.color.getHex(),
    };
    dn.setTime(15);
    expect(attribute.version, 'unchanged colours write nothing').toBe(version);
    expect(domeColors(dn.dome!)).toEqual(written);
    // The sun still moves: position, shading direction, intensity and colour all follow the hour.
    expect(dn.sun.position.equals(night.position)).toBe(false);
    expect(sunDirection(dn).equals(night.direction)).toBe(false);
    expect(dn.sun.intensity).not.toBe(night.intensity);
    expect(dn.sun.color.getHex()).not.toBe(night.color);
    expect(scene.children).toContain(dn.sun.target);
    // A palette that does change still writes the dome.
    const real = new DayNight(new Scene(), { shadow: false });
    const realAttribute = real.dome!.geometry.getAttribute('color') as BufferAttribute;
    const realVersion = realAttribute.version;
    real.setTime(0);
    expect(realAttribute.version).toBeGreaterThan(realVersion);
    expect(domeColors(real.dome!)).not.toEqual(domeColors(dn.dome!));
  });

  it('refreshDome() drops the cache so the next setTime rewrites the dome', () => {
    const flat = { dayZenith: 0x336699, nightZenith: 0x336699, dayHorizon: 0x99bbdd, nightHorizon: 0x99bbdd };
    const dn = new DayNight(new Scene(), { shadow: false, colors: flat });
    const attribute = dn.dome!.geometry.getAttribute('color') as BufferAttribute;
    const written = domeColors(dn.dome!);
    // `dome` is public: a caller rewrites its colours (or swaps the geometry) behind the cache's back.
    (attribute.array as Float32Array).fill(0);
    dn.setTime(9);
    expect(domeColors(dn.dome!), 'cached: an equal palette leaves the overwritten dome alone').toEqual(
      written.map(() => 0),
    );
    dn.refreshDome();
    dn.setTime(9);
    expect(domeColors(dn.dome!), 'after refreshDome the next setTime writes it back').toEqual(written);
  });

  it('dispose removes what it added and restores fog and background', () => {
    const { scene, dn } = setup();
    dn.setTime(12);
    dn.dispose();
    expect(
      scene.children.some((c) => c === dn.sun || c === dn.dome || c === dn.hemisphere || c === dn.sun.target),
    ).toBe(false);
    expect((scene.fog as Fog).color.getHex()).toBe(0x123456);
    expect((scene.background as Color).getHex()).toBe(0x654321);
  });
});
