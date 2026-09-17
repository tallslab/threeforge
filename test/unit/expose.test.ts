import { BoxGeometry, Mesh, MeshStandardMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { type AgentHook, exposeToAgents } from '../../src/agent/expose.js';
import { World } from '../../src/compiler/World.js';
import { DrawCallLedger } from '../../src/ledger/DrawCallLedger.js';
import { tag } from '../../src/tags.js';
import { FakeRenderer, sceneWithCamera } from './helpers/fakeRenderer.js';

describe('exposeToAgents', () => {
  it('publishes the hook on the target, renders through frameAsync, compiles once and disposes cleanly', async () => {
    const { scene, camera } = sceneWithCamera();
    const box = new BoxGeometry();
    const material = new MeshStandardMaterial();
    for (let i = 0; i < 3; i++) scene.add(tag.static(new Mesh(box, material)));
    const renderer = new FakeRenderer();
    const ledger = new DrawCallLedger();
    ledger.attach(renderer as never);
    const world = new World(scene, { ledger });
    const target: { __threeforge?: AgentHook } = {};
    const dispose = exposeToAgents({
      ledger,
      world,
      renderer: renderer as never,
      scene,
      camera,
      target,
      requestFrame: (cb) => cb(),
    });
    const hook = target.__threeforge!;
    expect(hook.schemaVersion).toBe(3);
    expect(hook.schemaVersion).toBe(ledger.frame().schemaVersion);
    expect(typeof hook.version).toBe('string');
    const frame = await hook.frameAsync();
    expect(frame.totals.sceneSubmissions).toBe(3);
    expect(hook.frame().totals.sceneSubmissions).toBe(3);
    expect(hook.compile!().after.batches).toBe(1);
    expect(hook.compile).toBeUndefined(); // compiled: the method is withdrawn until decompile()
    expect((await hook.frameAsync()).totals.sceneSubmissions).toBe(1);
    hook.decompile!();
    expect(hook.compile).toBeDefined();
    expect((await hook.frameAsync()).totals.sceneSubmissions).toBe(3);
    expect(hook.measureMemory().estimated).toBe(true);
    expect(Array.isArray(hook.hints())).toBe(true);
    expect(hook.report()).toContain('threeforge ledger');
    expect(typeof hook.measureOverdraw).toBe('function');
    dispose();
    expect(target.__threeforge).toBeUndefined();
  });

  it('without renderer, scene and camera, frameAsync only waits and reads', async () => {
    const ledger = new DrawCallLedger();
    const target: { __threeforge?: AgentHook } = {};
    exposeToAgents({ ledger, target, requestFrame: (cb) => cb() });
    expect(target.__threeforge!.measureOverdraw).toBeUndefined();
    expect(target.__threeforge!.compile).toBeUndefined();
    expect((await target.__threeforge!.frameAsync()).totals.submissions).toBe(0);
  });

  it('frameAsync rejects when the render throws on a later animation frame', async () => {
    const { scene, camera } = sceneWithCamera();
    const ledger = new DrawCallLedger();
    const renderer = {
      render: () => {
        throw new Error('device lost');
      },
    };
    const target: { __threeforge?: AgentHook } = {};
    exposeToAgents({
      ledger,
      renderer: renderer as never,
      scene,
      camera,
      target,
      requestFrame: (cb) => setTimeout(cb, 0),
    });
    await expect(target.__threeforge!.frameAsync()).rejects.toThrow('device lost');
  }, 2000);
});
