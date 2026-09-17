import { DrawCallLedger, type DrawCallLedgerOptions } from '../../../src/ledger/DrawCallLedger.js';
import { MaterialRegistry } from '../../../src/registry/MaterialRegistry.js';
import { FakeRenderer, type FakeRendererOptions, sceneWithCamera } from './fakeRenderer.js';

/** A fake renderer with a ledger attached, plus the registry it files against and an empty scene with a camera. */
export function attachedLedger(
  renderer: FakeRendererOptions = {},
  options: Omit<DrawCallLedgerOptions, 'registry'> = {},
) {
  const fake = new FakeRenderer(renderer);
  const registry = new MaterialRegistry();
  const ledger = new DrawCallLedger({ registry, ...options });
  ledger.attach(fake as never);
  const { scene, camera } = sceneWithCamera();
  return { renderer: fake, registry, ledger, scene, camera };
}
