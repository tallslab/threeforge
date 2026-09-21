/**
 * Stepped sequences: one record per rendered step, checked frame by frame. A failure writes the first failing frame
 * and the worst one, each with its reference, their diff and both neighbours, plus `sequence.json`: every step in
 * order with its inputs, camera, buffer sizes and adapter, and the pages that were opened. A temporal failure can
 * depend on the frames before it, so the record is the whole sequence and the way back is the printed command. It all
 * goes outside the repository, to a directory of its own under `FORGE_TEMPORAL_OUT` (default: the system temp
 * directory), which the error names.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { TestInfo } from '@playwright/test';
import { type ForgePage, note } from './fixtures.js';
import { differingPixels, pixelDiff } from './pixels.js';

export interface Step {
  label: string;
  png: Buffer;
  /** What this step is expected to look like. */
  reference: Buffer;
  /** What the scenario set for this step: simulation time, level, scale and what it measured. */
  state: Record<string, unknown>;
}

/** What the page looked through when a step was recorded. */
async function pageState(forge: ForgePage) {
  const page = await forge.page.evaluate(() => {
    const f = window.__forge;
    const camera = f.camera;
    const canvas = f.renderer.domElement;
    const buffer = f.renderer.getDrawingBufferSize(new f.three.Vector2());
    return {
      url: location.pathname + location.search,
      camera: {
        position: camera.position.toArray(),
        quaternion: camera.quaternion.toArray(),
        fov: camera.fov,
        aspect: camera.aspect,
        near: camera.near,
        far: camera.far,
        zoom: camera.zoom,
        projectionMatrix: camera.projectionMatrix.toArray(),
      },
      canvas: [canvas.width, canvas.height],
      layout: [canvas.clientWidth, canvas.clientHeight],
      drawingBuffer: [buffer.x, buffer.y],
      pixelRatio: f.renderer.getPixelRatio(),
      devicePixelRatio: window.devicePixelRatio,
      // The ledger's last frame, not `f.frame()`: that one renders, and a render between two steps could flush a
      // one-frame-late effect before the next step gets to see it.
      env: f.ledger.frame().env,
    };
  });
  return { ...page, viewport: forge.page.viewportSize() };
}

type Recorded<S> = S & { page: Awaited<ReturnType<typeof pageState>> };

/** `S` adds what a scenario measured at each step, next to the frame it was measured on. */
export class Sequence<S extends Step = Step> {
  readonly steps: Recorded<S>[] = [];
  private readonly info: TestInfo;
  private readonly forge: ForgePage;

  constructor(info: TestInfo, forge: ForgePage) {
    this.info = info;
    this.forge = forge;
  }

  /** Adds a step, with the camera, buffer sizes and adapter the page has right now. */
  async record(step: S): Promise<void> {
    this.steps.push({ ...step, page: await pageState(this.forge) });
  }

  /** Runs the assertions about step `index`. */
  check(index: number, assertions: (step: Recorded<S>) => void): void {
    try {
      assertions(this.steps[index]!);
    } catch (error) {
      throw this.failed(error, { index }, { index });
    }
  }

  /**
   * Holds every step to a bound: `measure` gives the step's value (`undefined`: not measured) and `assertion` is the
   * expectation on it. Returns the largest value measured. When steps fail, the first in time and the one with the
   * largest value are both written: the first is where it began, the worst is what it grew into.
   */
  bound(
    measure: (step: Recorded<S>, index: number) => number | undefined,
    assertion: (value: number, step: Recorded<S>) => void,
  ): { index: number; value: number } {
    let largest = { index: 0, value: Number.NEGATIVE_INFINITY };
    let first: { index: number; value: number } | undefined;
    let worst: { index: number; value: number; error: unknown } | undefined;
    this.steps.forEach((step, index) => {
      const value = measure(step, index);
      if (value === undefined) return;
      if (value > largest.value) largest = { index, value };
      try {
        assertion(value, step);
      } catch (error) {
        first ??= { index, value };
        if (!worst || value > worst.value) worst = { index, value, error };
      }
    });
    if (first && worst) throw this.failed(worst.error, first, { index: worst.index, value: worst.value });
    return largest;
  }

  private failed(
    error: unknown,
    first: { index: number; value?: number },
    worst: { index: number; value?: number },
  ): unknown {
    const { info } = this;
    const file = relative(process.cwd(), info.file);
    const adapter = process.env.FORGE_WEBGPU ? `FORGE_WEBGPU=${process.env.FORGE_WEBGPU} ` : '';
    const command = `${adapter}pnpm exec playwright test ${file}:${info.line} --project=${info.project.name}`;
    const named = ({ index, value }: { index: number; value?: number }): string =>
      `step ${index} (${this.steps[index]!.label})${value === undefined ? '' : `, value ${value}`}`;

    const root = process.env.FORGE_TEMPORAL_OUT ?? join(tmpdir(), 'threeforge-temporal');
    mkdirSync(root, { recursive: true });
    // Playwright's own directory name carries the test, the project and the retry; the suffix keeps reruns apart.
    const dir = mkdtempSync(join(root, `${basename(info.outputDir)}-`));
    const selected = new Set<number>();
    for (const at of [first.index, worst.index])
      for (const i of [at - 1, at, at + 1]) if (i >= 0 && i < this.steps.length) selected.add(i);
    for (const i of selected) {
      const { label, png, reference } = this.steps[i]!;
      const base = join(dir, `${String(i).padStart(2, '0')}-${label}`);
      writeFileSync(`${base}.png`, png);
      writeFileSync(`${base}.reference.png`, reference);
      pixelDiff(png, reference, { threshold: 4, diffPath: `${base}.diff.png` });
    }
    const message = stripVTControlCharacters(error instanceof Error ? error.message : String(error));
    const sequence = {
      test: {
        file,
        line: info.line,
        title: info.titlePath.slice(1).join(' › '),
        tags: info.tags,
        project: info.project.name,
        retry: info.retry,
        repeatEachIndex: info.repeatEachIndex,
      },
      command,
      needs: info.tags.includes('@corpus') ? 'the Kenney kits: pnpm assets:kits' : null,
      environment: { FORGE_WEBGPU: process.env.FORGE_WEBGPU ?? null, platform: process.platform },
      opened: this.forge.opened,
      failure: { first, worst, error: message },
      steps: this.steps.map(({ label, state, page }, index) => ({ index, label, inputs: state, page })),
    };
    writeFileSync(join(dir, 'sequence.json'), JSON.stringify(sequence, null, 2));
    note('temporal-artifacts', dir);
    if (error instanceof Error)
      error.message +=
        `\nfirst failing frame: ${named(first)}\nworst failing frame: ${named(worst)}` +
        `\nframes and sequence.json: ${dir}\nreproduce: ${command}` +
        (sequence.needs ? ` (needs ${sequence.needs})` : '');
    return error;
  }
}

/**
 * Differing pixels as a share of the pixels the content covers (`reference` against the `empty` background), so a
 * defect confined to one object is measured against that object and not against the whole frame.
 */
export function shareOfContent(png: Buffer, reference: Buffer, empty: Buffer): number {
  const covered = differingPixels(reference, empty, { threshold: 4 });
  return covered === 0 ? 1 : differingPixels(png, reference, { threshold: 4 }) / covered;
}
