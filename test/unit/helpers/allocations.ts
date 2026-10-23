import { Session } from 'node:inspector/promises';

interface ProfileNode {
  callFrame: { url: string };
  selfSize: number;
  children: ProfileNode[];
}

/**
 * Bytes allocated per call of `fn` outside three, from V8's sampling heap profiler (collected objects included) over a
 * synchronous loop, after two rounds of `warm` calls: unoptimised code boxes doubles, which says nothing of the code.
 * three's frames are left out, since its math returns doubles across calls V8 does not always inline
 * (`Frustum.setFromProjectionMatrix`, `Vector3.length`); threeforge, bvh.js and built-ins such as `Math.hypot` count.
 */
export async function bytesPerCall(fn: () => void, calls = 20_000, warm = 20_000): Promise<number> {
  for (let i = 0; i < warm; i++) fn();
  // V8 optimises on a background thread: give it a moment to install the code, then run it, before measuring. On a
  // loaded machine (the whole suite in parallel) the measured loop otherwise starts in unoptimised code.
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (let i = 0; i < warm; i++) fn();
  const inspector = new Session();
  inspector.connect();
  await inspector.post('HeapProfiler.enable');
  await inspector.post('HeapProfiler.collectGarbage');
  await inspector.post('HeapProfiler.startSampling', {
    samplingInterval: 64,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  } as never);
  for (let i = 0; i < calls; i++) fn();
  const { profile } = (await inspector.post('HeapProfiler.stopSampling')) as unknown as {
    profile: { head: ProfileNode };
  };
  inspector.disconnect();
  let bytes = 0;
  // An allocation belongs to the innermost frame with a source: an engine built-in (`push`) to whoever called it.
  const walk = (node: ProfileNode, owner: string): void => {
    const url = node.callFrame.url || owner;
    // `node:` frames are the inspector's own protocol messages.
    if (!url.includes('/three/') && !url.startsWith('node:')) bytes += node.selfSize;
    for (const child of node.children) walk(child, url);
  };
  walk(profile.head, '');
  return bytes / calls;
}
