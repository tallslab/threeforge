import type { BufferAttribute } from 'three';

/** Past this many pending update ranges an attribute's list is replaced by one range over the whole buffer. */
export const MAX_UPDATE_RANGES = 32;

/** How a write marks an instance attribute for upload. */
export const MARK_ALL = 0; // needsUpdate without ranges: a uniform buffer per render object is written whole anyway
export const MARK_ROWS = 1; // a range over the rows written
export const MARK_WHOLE = 2; // a range over the whole buffer

/**
 * Marks an instance attribute for upload (`mode`: MARK_ALL, MARK_ROWS or MARK_WHOLE). A whole-buffer range stays in the
 * list until three's frame event consumes it, so a later sync never uploads less than every row written before it.
 */
export function markRows(attribute: BufferAttribute, start: number, count: number, mode: number): void {
  if (mode !== MARK_ALL) {
    const ranges = attribute.updateRanges;
    const whole = attribute.array.length;
    const last = ranges.length > 0 ? ranges[ranges.length - 1]! : null;
    if (ranges.length >= MAX_UPDATE_RANGES) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, whole);
    } else if (mode === MARK_WHOLE) {
      if (last === null || last.start !== 0 || last.count !== whole) attribute.addUpdateRange(0, whole);
    } else {
      attribute.addUpdateRange(start, count);
    }
  }
  attribute.needsUpdate = true;
}

/** What the row writer needs of a level mesh. */
export interface LevelMesh {
  count: number;
  /** Compacted index -> master index for rows `[0, count)`. */
  visibleIds: number[];
  instanceMatrix: BufferAttribute;
  instanceColor: BufferAttribute | null;
}

/**
 * The instance-buffer rows of every level of a culled instanced mesh: writes the instances a cull or append listed
 * into rows, copying only the rows whose instance changed, and keeps `count` and `visibleIds` in step.
 */
export class InstanceRows {
  /** Per level: the instances of the running cull or append, and how many. */
  readonly lists: Int32Array[];
  readonly listLength: Int32Array;
  /** Per level: the instance row k holds, -1 when unknown (level 0 starts with every instance in order). */
  private readonly rowIds: Int32Array[];
  /** A master matrix changed: every row is rewritten at its next write. */
  private stale = false;
  /** How the running call's writes mark the matrices and the colours (see `markRows`). */
  private matrixMark = MARK_ALL;
  private colorMark = MARK_WHOLE;

  constructor(
    private readonly levels: LevelMesh[],
    private readonly masterMatrices: Float32Array,
    private readonly masterColors: Float32Array | null,
  ) {
    const n = masterMatrices.length / 16;
    this.lists = levels.map(() => new Int32Array(n));
    this.listLength = new Int32Array(levels.length);
    this.rowIds = levels.map((_, L) => {
      const rows = new Int32Array(n).fill(-1);
      if (L === 0) for (let i = 0; i < n; i++) rows[i] = i;
      return rows;
    });
  }

  /** A master matrix changed: the rows no longer hold what `rowIds` says. */
  invalidate(): void {
    this.stale = true;
  }

  /** Starts a hook call: how its writes mark the buffers; forgets the row contents after a matrix change. */
  begin(matrixMark: number, colorMark: number): void {
    this.matrixMark = matrixMark;
    this.colorMark = colorMark;
    if (this.stale) {
      for (const rows of this.rowIds) rows.fill(-1);
      this.stale = false;
    }
  }

  setCount(L: number, count: number): void {
    const mesh = this.levels[L]!;
    mesh.count = count;
    mesh.visibleIds.length = count;
  }

  /** Writes `lists[L]` into rows `[at, at + length)` of level L and sets its count; marks only the rows that changed. */
  writeRows(L: number, at: number): void {
    const mesh = this.levels[L]!;
    const rows = this.rowIds[L]!;
    const list = this.lists[L]!;
    const length = this.listLength[L]!;
    const masterMatrices = this.masterMatrices;
    const masterColors = this.masterColors;
    const matrixArray = mesh.instanceMatrix.array as Float32Array;
    const colorArray = mesh.instanceColor ? (mesh.instanceColor.array as Float32Array) : null;
    const visible = mesh.visibleIds;
    visible.length = at + length;
    let first = -1;
    let last = -1;
    for (let k = 0; k < length; k++) {
      const id = list[k]!;
      const row = at + k;
      visible[row] = id;
      if (rows[row] === id) continue;
      rows[row] = id;
      for (let e = 0; e < 16; e++) matrixArray[row * 16 + e] = masterMatrices[id * 16 + e]!;
      if (colorArray !== null && masterColors !== null)
        for (let e = 0; e < 3; e++) colorArray[row * 3 + e] = masterColors[id * 3 + e]!;
      if (first < 0) first = row;
      last = row;
    }
    mesh.count = at + length;
    if (first < 0) return;
    markRows(mesh.instanceMatrix, first * 16, (last - first + 1) * 16, this.matrixMark);
    if (mesh.instanceColor) markRows(mesh.instanceColor, first * 3, (last - first + 1) * 3, this.colorMark);
  }
}
