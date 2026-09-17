/**
 * Shadow pass id assignment (`src/ledger/shadowPasses.ts`), unit-tested without a renderer: it is a pure function of
 * the scene's shadow-casting lights, in scene order, and the ids the frame has already handed out to other scenes.
 *
 * The rules it has to keep (the ledger end of them is in `lighting-section.test.ts`):
 * - `shadow:<name>` for a light whose name no other shadow-casting light of the scene has;
 * - `shadow:<name>#k`, k from 1 in scene order, for lights that share a name;
 * - an unnamed light is named after its type, so unnamed lights of one type share a name and get numbered;
 * - an id another scene of the same frame already took moves on to the next free k.
 */
import { describe, expect, it } from 'vitest';
import { shadowPassIds } from '../../src/ledger/shadowPasses.js';

const light = (name: string, type = 'DirectionalLight') => ({ name, type });

describe('shadowPassIds', () => {
  it('keeps shadow:<name> for a name no other shadow-casting light of the scene has', () => {
    const ids = shadowPassIds([light('sun'), light('lamp', 'SpotLight')], new Set());
    expect(ids).toEqual(['shadow:sun', 'shadow:lamp']);
  });

  it('numbers lights that share a name #k from 1, in scene order', () => {
    const ids = shadowPassIds([light('lamp', 'SpotLight'), light('sun'), light('lamp', 'SpotLight')], new Set());
    expect(ids).toEqual(['shadow:lamp#1', 'shadow:sun', 'shadow:lamp#2']);
  });

  it('names an unnamed light after its type, so unnamed lights of one type are numbered and two types are not', () => {
    const ids = shadowPassIds([light(''), light(''), light('', 'SpotLight')], new Set());
    expect(ids).toEqual(['shadow:DirectionalLight#1', 'shadow:DirectionalLight#2', 'shadow:SpotLight']);
  });

  it('moves a unique name past an id another scene of the frame already took', () => {
    const taken = new Set(['shadow:sun']);
    expect(shadowPassIds([light('sun')], taken)).toEqual(['shadow:sun#2']);
  });

  it('moves numbered ids past the ones already taken, to the next free k each', () => {
    const taken = new Set(['shadow:lamp#1', 'shadow:lamp#3']);
    expect(shadowPassIds([light('lamp', 'SpotLight'), light('lamp', 'SpotLight')], taken)).toEqual([
      'shadow:lamp#2',
      'shadow:lamp#4',
    ]);
  });

  it('adds every id it hands out to `taken`, so the next scene of the frame sees them', () => {
    const taken = new Set<string>();
    shadowPassIds([light('sun'), light('lamp', 'SpotLight'), light('lamp', 'SpotLight')], taken);
    expect([...taken].sort()).toEqual(['shadow:lamp#1', 'shadow:lamp#2', 'shadow:sun']);
    // A second scene's lights, with the first scene's ids already taken. Numbering is per scene: this scene's one
    // `lamp` is unique in it, so it asks for the bare `shadow:lamp`, which the first scene never took (it took #1/#2).
    expect(shadowPassIds([light('sun'), light('lamp', 'SpotLight')], taken)).toEqual(['shadow:sun#2', 'shadow:lamp']);
  });

  it('returns one id per light, in the order given, and nothing for no lights', () => {
    expect(shadowPassIds([], new Set())).toEqual([]);
    const lights = [light('a'), light('b'), light('a')];
    expect(shadowPassIds(lights, new Set())).toHaveLength(lights.length);
  });
});
