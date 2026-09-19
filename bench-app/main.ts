import { describeError } from 'threeforge';
import { type BenchMetrics, SCENE_IDS, type SceneId } from '../test/app/benchMetrics.js';
import { createHost, type Host, runBench } from './runner.js';
import { type DeviceResult, issueBody, issueUrl } from './submit.js';
import { deviceRows, liveRows } from './table.js';

declare global {
  interface Window {
    /**
     * What a script driving the page reads. `done` means the run ended, not that it passed: it is set on failure
     * too, so that waiting for it never hangs. A run passed when `done` is true and `error` is unset; `result` is
     * null otherwise. Every run resets `done`, `error`, `result` and `env` as it starts, so none of them ever
     * describes the run before.
     */
    __bench: {
      ready: boolean;
      error?: string;
      backend?: string;
      env?: DeviceResult['env'];
      progress: string;
      result: DeviceResult | null;
      done: boolean;
    };
  }
}

const REPO = import.meta.env.VITE_FORGE_REPO ?? '';
const params = new URLSearchParams(location.search);
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
window.__bench = { ready: false, progress: '', result: null, done: false };

const live: Partial<Record<SceneId, { naive?: BenchMetrics; optimized?: BenchMetrics }>> = {};
const setProgress = (text: string): void => {
  window.__bench.progress = text;
  $('progress').textContent = text;
};

async function start(host: Host): Promise<void> {
  $('run').setAttribute('disabled', '');
  $('submit').hidden = true;
  // Every run starts clean: a script waiting for `done` must not be handed the run before, nor a retry its error.
  Object.assign(window.__bench, { done: false, result: null });
  delete window.__bench.error;
  delete window.__bench.env;
  for (const id of SCENE_IDS) delete live[id];
  $('liveBody').innerHTML = liveRows(live);
  const ids = params
    .get('scenes')
    ?.split(',')
    .filter((s): s is SceneId => (SCENE_IDS as readonly string[]).includes(s)) ?? [...SCENE_IDS];
  const measured = Math.max(1, Number(params.get('measured') ?? '60'));
  try {
    const result = await runBench(host, {
      sceneIds: ids.length ? ids : [...SCENE_IDS],
      measured,
      probe: params.get('probe') !== '0',
      onProgress: setProgress,
      onScene: (id, variant, m) => {
        (live[id] ??= {})[variant] = m;
        $('liveBody').innerHTML = liveRows(live);
      },
    });
    window.__bench.result = result;
    window.__bench.env = result.env;
    $('json').textContent = issueBody(result);
    const url = issueUrl(REPO, result);
    const link = $<HTMLAnchorElement>('issue');
    if (url) {
      link.href = url;
      link.hidden = false;
      $('manual').hidden = true;
    } else {
      link.hidden = true;
      $('manual').hidden = false;
      $<HTMLAnchorElement>('template').href = REPO
        ? `https://github.com/${REPO}/issues/new?template=bench-result.yml`
        : '#';
    }
    $('submit').hidden = false;
    setProgress(
      `done · ${ids.length || SCENE_IDS.length} scenes on ${host.backend} · ${result.env.gpu}${result.env.fillRateGPix === null ? '' : ` · fill ${result.env.fillRateGPix.toFixed(1)} GPix/s`}`,
    );
  } catch (error) {
    window.__bench.error = describeError(error, 'stack');
    setProgress(`failed: ${describeError(error)}`);
  } finally {
    window.__bench.done = true;
    $('run').removeAttribute('disabled');
  }
}

async function main(): Promise<void> {
  const repoLink = $<HTMLAnchorElement>('repoLink');
  if (/^[\w.-]+\/[\w.-]+$/.test(REPO)) {
    repoLink.href = `https://github.com/${REPO}`;
    repoLink.hidden = false;
  }
  $('liveBody').innerHTML = liveRows({});
  fetch(new URL('devices.json', document.baseURI).href)
    .then((r) => (r.ok ? r.json() : []))
    .then((list: DeviceResult[]) => {
      $('devicesBody').innerHTML = deviceRows(list);
      $('devicesCount').textContent = `${list.length} result${list.length === 1 ? '' : 's'}`;
    })
    .catch(() => {});
  const select = $<HTMLSelectElement>('backend');
  const want = params.get('backend') === 'webgl2' ? 'webgl2' : params.get('backend') === 'webgpu' ? 'webgpu' : 'auto';
  select.value = want;
  select.addEventListener('change', () => {
    const q = new URLSearchParams(location.search);
    if (select.value === 'auto') q.delete('backend');
    else q.set('backend', select.value);
    location.search = q.toString();
  });
  const host = await createHost(want, $('canvasMount'));
  window.__bench.ready = true;
  window.__bench.backend = host.backend;
  $('device').textContent =
    `${host.gpu} · ${host.backend} · tier ${host.tier} · dpr ${devicePixelRatio} · ${navigator.hardwareConcurrency ?? '?'} cores`;
  $('run').addEventListener('click', () => void start(host));
  $('copy').addEventListener('click', () => void navigator.clipboard.writeText($('json').textContent ?? ''));
  if (params.get('auto') === '1') await start(host);
}

main().catch((error) => {
  window.__bench.error = describeError(error, 'stack');
  window.__bench.done = true;
  setProgress(`failed: ${describeError(error)}`);
});
