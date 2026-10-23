/**
 * What a frame allocates in JavaScript once the scene is warm, from V8's sampling heap profiler (collected objects
 * included) over animation frames that move the camera and advance the scene's clock, with the ledger detached as a
 * shipped game runs (zen's clock steps its Streamer with `step()`, which builds no stats). An allocation belongs to the innermost frame with a source (an engine built-in such as `push`
 * belongs to whoever called it). threeforge's share is every byte allocated under one of its frames (its render hooks,
 * the Streamer, AnimatedInstances) by anything but three's own code, such as the update range `addUpdateRange` records
 * when threeforge uploads only the instance rows it changed; it must stay under 16 bytes a frame, a margin for the odd
 * double V8 boxes, against the 2 to 10 KB the culling and streaming paths allocated before. three r186's renderer allocates every
 * frame on its own, which is recorded as an annotation and not asserted.
 */
import type { CDPSession } from '@playwright/test';
import { expect, test } from './fixtures.js';

interface Node {
  callFrame: { functionName: string; url: string; lineNumber: number };
  selfSize: number;
  children: Node[];
}

/** village and zen are procedural; crowd and arena read the Kenney kits from the downloaded corpus. */
const SCENES: Array<[string, Record<string, string>, string[]]> = [
  ['village', { variant: 'optimized' }, []],
  ['zen', { variant: 'optimized' }, []],
  ['crowd', { variant: 'optimized' }, ['@corpus']],
  ['arena', { freeze: '1', dynamics: 'batch-sync', t: '1.1' }, ['@corpus']],
];
const WARM = 1500;
const FRAMES = 150;

const isForge = (url: string): boolean => url.includes('/src/');
const isThree = (url: string): boolean => /\/three[./@]|three\.(core|webgpu)/.test(url) && !isForge(url);

/**
 * Bytes in one profile: an allocation belongs to the innermost frame with a source; threeforge's are those under one of
 * its frames whose owner is not three.
 */
function measure(head: Node): { forgeBytes: number; threeBytes: number; sites: Map<string, number> } {
  let forgeBytes = 0;
  let threeBytes = 0;
  const sites = new Map<string, number>();
  const walk = (node: Node, underForge: boolean, parent = '', owner = ''): void => {
    const { url, functionName, lineNumber } = node.callFrame;
    const under = underForge || isForge(url);
    const source = url || owner;
    if (node.selfSize > 0) {
      if (isThree(source)) threeBytes += node.selfSize;
      else if (under) {
        forgeBytes += node.selfSize;
        const site = `${url.split('/').slice(-2).join('/')}:${lineNumber + 1} ${functionName} <- ${parent}`;
        sites.set(site, (sites.get(site) ?? 0) + node.selfSize);
      }
    }
    const here = `${url.split('/').pop()}:${lineNumber + 1} ${functionName}`;
    for (const child of node.children) walk(child, under, here, source);
  };
  walk(head, false);
  return { forgeBytes, threeBytes, sites };
}

async function profile(cdp: CDPSession, run: () => Promise<void>): Promise<Node> {
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.startSampling', {
    samplingInterval: 128,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  } as never);
  await run();
  const { profile } = (await cdp.send('HeapProfiler.stopSampling')) as unknown as { profile: { head: Node } };
  return profile.head;
}

// `@alloc`: the warm-up V8 needs before a measurement means anything takes minutes on SwiftShader, so the
// per-change CI job leaves these to the weekly full run and the native run before a release.
for (const [scene, query, tags] of SCENES)
  test(`a warm ${scene} frame allocates under 16 bytes in threeforge`, { tag: ['@alloc', ...tags] }, async ({
    forge,
  }) => {
    test.setTimeout(180_000);
    await forge.open(scene, query);
    await forge.page.evaluate(
      ({ warm }) => {
        const f = window.__forge;
        f.ledger.detach();
        let t = 1;
        const step = (): void => {
          t += 1 / 60;
          f.arena?.setTime(t);
          f.bench?.setTime?.(t);
          f.camera.position.x = Math.sin(t) * 2;
          f.camera.updateMatrixWorld();
          f.renderer.render(f.scene, f.camera);
        };
        (window as unknown as { __step: () => void }).__step = step;
        // Warm-up without waiting on frames: enough calls for V8 to optimise the hot paths.
        for (let i = 0; i < warm; i++) step();
      },
      { warm: WARM },
    );
    const cdp = await forge.page.context().newCDPSession(forge.page);
    const runFrames = () =>
      forge.page.evaluate(
        (frames) =>
          new Promise<void>((done) => {
            let i = 0;
            const tick = (): void => {
              (window as unknown as { __step: () => void }).__step();
              if (++i < frames) requestAnimationFrame(tick);
              else done();
            };
            requestAnimationFrame(tick);
          }),
        FRAMES,
      );
    // Two windows, the smaller kept: a per-frame allocation shows in both, while a one-off (V8 installing optimised
    // code mid-window, measured once at 24 B a frame in six zen runs) shows in one.
    const windows = [measure(await profile(cdp, runFrames)), measure(await profile(cdp, runFrames))];
    const { forgeBytes, threeBytes, sites } =
      windows[0]!.forgeBytes <= windows[1]!.forgeBytes ? windows[0]! : windows[1]!;
    const perFrame = (bytes: number): number => Math.round(bytes / FRAMES);
    test.info().annotations.push({
      type: 'allocations',
      description: `${scene} ${forge.backend}: threeforge ${perFrame(forgeBytes)} B/frame, three ${perFrame(threeBytes)} B/frame`,
    });
    console.log(
      `allocations ${scene} ${forge.backend}: threeforge ${perFrame(forgeBytes)} B/frame · three ${perFrame(threeBytes)} B/frame`,
    );
    const top = [...sites]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([s, b]) => `${perFrame(b)} B/frame ${s}`);
    if (process.env.ALLOC_DEBUG) console.log(top.map((t) => `  ${t}`).join('\n'));
    expect(perFrame(forgeBytes), top.join('\n')).toBeLessThan(16);
  });
