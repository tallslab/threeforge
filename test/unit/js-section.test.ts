import { describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial } from 'three';
import { DrawCallLedger } from '../../src/ledger/DrawCallLedger.js';
import { FakeRenderer, sceneWithCamera } from './helpers/fakeRenderer.js';

describe('js section', () => {
  it('measures render duration and frame interval with the injected clock, and counts auto-updated matrices', () => {
    let t = 0;
    const ledger = new DrawCallLedger({ now: () => t });
    const renderer = new FakeRenderer();
    // render() takes 3 ms; frames start 16 ms apart
    const origRender = renderer.render.bind(renderer);
    (renderer as { render: typeof origRender }).render = (s, c) => {
      t += 3;
      return origRender(s, c);
    };
    ledger.attach(renderer as never);
    const { scene, camera } = sceneWithCamera();
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

  it('rescan() refreshes the graph statistics between the periodic recounts', () => {
    const ledger = new DrawCallLedger({ now: () => 0 });
    const renderer = new FakeRenderer();
    ledger.attach(renderer as never);
    const { scene, camera } = sceneWithCamera();
    renderer.render(scene, camera);
    expect(ledger.frame().js.objects).toBe(0);
    scene.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial()));
    renderer.render(scene, camera);
    expect(ledger.frame().js.objects).toBe(0); // not recounted yet (every 60 frames)
    ledger.rescan();
    expect(ledger.frame().js.objects).toBe(1);
  });
});
