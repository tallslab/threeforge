import { BoxGeometry, Mesh, MeshBasicMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { attachedLedger } from './helpers/ledger.js';

// The fake calls `scene.onBeforeRender` inside render(), so a clock ticked there lands inside the ledger's timing of the
// render, and `scene.onAfterRender` runs after the draws and before the ledger files the frame.
describe('js section', () => {
  it('measures render duration and frame interval with the injected clock, and counts auto-updated matrices', () => {
    let t = 0;
    const { renderer, ledger, scene, camera } = attachedLedger({ sceneHooks: true }, { now: () => t });
    // render() takes 3 ms; frames start 16 ms apart
    scene.onBeforeRender = () => {
      t += 3;
    };
    const a = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    const b = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    b.matrixAutoUpdate = false;
    scene.add(a, b);
    for (let i = 0; i < 4; i++) {
      renderer.render(scene, camera);
      t += 13;
    }
    const js = ledger.frame().js;
    expect(js.renderMs).toBe(3);
    expect(js.frameMs).toBe(16);
    expect(js.objects).toBe(2);
    expect(js.autoUpdatedMatrices).toBe(1);
  });

  it('stops renderMs when the ledger starts filing the frame: a 20 ms rescan shows in ledgerMs and leaves renderMs unchanged (queued clock)', () => {
    // The injected clock moves only by the costs queued on it: 3 ms per render() call, 20 ms per rescan.
    let t = 0;
    const { renderer, ledger, scene, camera } = attachedLedger({ sceneHooks: true }, { now: () => t });
    scene.onBeforeRender = () => {
      t += 3;
    };
    const rescan = ledger.rescan.bind(ledger);
    let rescans = 0;
    ledger.rescan = () => {
      rescans++;
      t += 20;
      rescan();
    };
    scene.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial()));
    const frames: Array<{ renderMs: number; ledgerMs: number; rescanned: boolean }> = [];
    for (let i = 0; i < 61; i++) {
      const before = rescans;
      renderer.render(scene, camera);
      const js = ledger.frame().js;
      frames.push({ renderMs: js.renderMs, ledgerMs: js.ledgerMs, rescanned: rescans > before });
      t += 13;
    }
    // The ledger rescans while filing the first frame and every 60 frames after it.
    expect(frames.flatMap((f, i) => (f.rescanned ? [i] : []))).toEqual([0, 60]);
    for (const [i, f] of frames.entries())
      expect(f, `frame ${i}`).toEqual({ renderMs: 3, ledgerMs: f.rescanned ? 20 : 0, rescanned: f.rescanned });
    // A rescan between frames changes neither timing of the last frame.
    ledger.rescan();
    expect(ledger.frame().js).toMatchObject({ renderMs: 3, ledgerMs: 20 });
  });

  /**
   * The case above charges the ledger's filing time through `rescan()`, on 2 of 61 frames; this one charges it on
   * every frame, so the ordinary filing path (the item walk, `buildFrame`, the hints) is covered too. The clock returns
   * the current reading and then advances it while the ledger is filing: the ledger reads it once at `renderEnd` (the
   * value the render cost alone produced) and once when filing is done, so a correct split reports renderMs 3 and
   * ledgerMs 7.
   */
  it("charges the ledger's own filing work to ledgerMs on an ordinary frame, and leaves renderMs the render alone", () => {
    let t = 0;
    let filing = false;
    // Post-increment: the reading is what the clock said before the ledger's own 7 ms of filing began.
    const { renderer, ledger, scene, camera } = attachedLedger(
      { sceneHooks: true },
      {
        now: () => {
          const reading = t;
          if (filing) t += 7;
          return reading;
        },
      },
    );
    scene.onBeforeRender = () => {
      t += 3; // the render itself
    };
    scene.onAfterRender = () => {
      filing = true; // everything from here to the end of the ledger's exit() is the ledger's own work
    };
    scene.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial()));
    const frames: Array<{ renderMs: number; ledgerMs: number }> = [];
    for (let i = 0; i < 4; i++) {
      renderer.render(scene, camera);
      filing = false;
      const js = ledger.frame().js;
      frames.push({ renderMs: js.renderMs, ledgerMs: js.ledgerMs });
      t += 13;
    }
    // Frame 0 rescans as well, which this clock does not charge separately; every frame files, so every frame pays.
    for (const [i, f] of frames.entries()) {
      expect(f.ledgerMs, `frame ${i}: the ledger's own work must be measured`).toBeGreaterThan(0);
      expect(f, `frame ${i}`).toEqual({ renderMs: 3, ledgerMs: 7 });
    }
  });

  it('rescan() refreshes the graph statistics between the periodic recounts', () => {
    const { renderer, ledger, scene, camera } = attachedLedger({}, { now: () => 0 });
    renderer.render(scene, camera);
    expect(ledger.frame().js.objects).toBe(0);
    scene.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial()));
    renderer.render(scene, camera);
    expect(ledger.frame().js.objects).toBe(0); // not recounted yet (every 60 frames)
    ledger.rescan();
    expect(ledger.frame().js.objects).toBe(1);
  });
});
