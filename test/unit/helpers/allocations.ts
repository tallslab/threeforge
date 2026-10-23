import { Session } from 'node:inspector/promises';

interface ProfileNode {
  callFrame: { functionName: string; url: string; lineNumber: number };
  selfSize: number;
  children: ProfileNode[];
}

/**
 * Bytes allocated per call of `fn` outside three itself, from V8's sampling heap profiler with collected objects
 * included, over a synchronous loop (nothing else runs during it), after `warm` calls so the hot paths are optimised:
 * in unoptimised code V8 boxes doubles, which says nothing about the code. Allocations whose allocating frame is three's
 * are left out: its math returns doubles across calls V8 does not always inline (`Frustum.setFromProjectionMatrix`,
 * `Vector3.length`), and three's renderer allocates every frame on its own, which the e2e measures separately.
 * threeforge, bvh.js and the engine's built-ins (`Math.hypot`, iterators) count; the inspector's own frames do not.
 */
export async function bytesPerCall(fn: () => void, calls = 20_000, warm = 20_000): Promise<number> {
  for (let i = 0; i < warm; i++) fn();
  // V8 optimises on a background thread: give it a moment to install the code, then run it, before measuring. On a
  // loaded machine (the whole suite in parallel) the measured loop otherwise starts in unoptimised code.
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (let i = 0; i < warm; i++) fn();
  const session = new Session();
  session.connect();
  await session.post('HeapProfiler.enable');
  await session.post('HeapProfiler.collectGarbage');
  await session.post('HeapProfiler.startSampling', {
    samplingInterval: 64,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  } as never);
  for (let i = 0; i < calls; i++) fn();
  const { profile } = (await session.post('HeapProfiler.stopSampling')) as unknown as {
    profile: { head: ProfileNode };
  };
  session.disconnect();
  let bytes = 0;
  const leaves = new Map<string, number>();
  // An allocation belongs to the innermost frame with a source: an engine built-in (`push`) to whoever called it.
  const walk = (node: ProfileNode, owner: string): void => {
    // `node:` frames are the inspector session's own messages.
    const url = node.callFrame.url || owner;
    if (!url.includes('/three/') && !url.startsWith('node:')) bytes += node.selfSize;
    if (process.env.ALLOC_DEBUG && node.selfSize > 0) {
      const key = `${node.callFrame.url.split('/').slice(-2).join('/')}:${node.callFrame.lineNumber + 1} ${node.callFrame.functionName}`;
      leaves.set(key, (leaves.get(key) ?? 0) + node.selfSize);
    }
    for (const child of node.children) walk(child, url);
  };
  walk(profile.head, '');
  if (process.env.ALLOC_DEBUG)
    for (const [k, v] of [...leaves].sort((a, b) => b[1] - a[1]).slice(0, 8))
      process.stderr.write(`ALLOC ${(v / calls).toFixed(1)} ${k}\n`);
  return bytes / calls;
}
