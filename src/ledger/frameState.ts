import type { Camera, Light, Object3D } from 'three';
import type { PathCache } from './names.js';
import type { ShadowPass } from './passNames.js';
import type { LightInfo } from './sections.js';
import type { SubmissionRecord } from './snapshot.js';

/** One `render()` call. The outermost call of a frame is `main`; nested calls are passes of it. */
export interface RenderContext {
  root: Object3D;
  pass: string;
  /** The display-name cache of `root`. */
  paths: PathCache;
  /** A shadow-map render: its scene submissions are shadow casters. */
  shadow: boolean;
}

/** A pooled record: the snapshot's `SubmissionRecord` plus what the ledger keeps per item and `frame()` leaves out. */
export interface PooledRecord extends SubmissionRecord {
  /**
   * three drew it as the back-side half of a double pass (`passId` `'backSide'`, Renderer._renderTransparents): the
   * second main-pass record of an object already filed once.
   */
  backSide: boolean;
}

/**
 * Submission records, reused frame after frame. The ledger keeps two: the frame in progress writes one while the last
 * completed frame's items stay intact in the other, so a read between or inside frames never sees a half-written frame.
 */
export interface RecordBuffer {
  /** Every record this buffer has created, in acquisition order; never shrinks. */
  records: PooledRecord[];
  /** The records filed this frame, in filing order (a pass nested inside a draw files before that draw). */
  items: PooledRecord[];
  acquired: number;
}

export interface FrameState {
  mainScene: Object3D | null;
  buffer: RecordBuffer;
  /**
   * Items filed into `buffer.items` so far. Not `items.length`: the frame overwrites the array in place and `exit()`
   * truncates it once, since setting `length = 0` at the start of every frame would release its backing store.
   */
  count: number;
  /** programHash → the type and description of the first item filed with it. */
  descriptions: Map<string, { type: string; description: string }>;
  drawCallsStart: number;
  trianglesStart: number;
  /** Shadow camera → its light and pass id, for every world-visible shadow-casting light this frame's walks found. */
  shadowCameras: Map<Camera, ShadowPass>;
  /** Every pass id given out this frame, across scenes: shadow ids (`shadowPassIds`) and nested/scene ids alike. */
  passIds: Set<string>;
  /** Σ mapSize.x · mapSize.y over the lights whose shadow map rendered this frame (mapSize.x² · 6 for a point light), each light once. */
  shadowTexels: number;
  /** Distinct objects drawn into a shadow map this frame. */
  shadowCasters: number;
  /** Distinct objects filed as `unsupported-material` this frame, in any pass. */
  unsupportedObjects: number;
  /** The last shadow-map pass entered: three renders a map's VSM blur quads right after the map. */
  lastShadowPass: string | null;
  scannedScenes: Set<Object3D>;
  nestedScenes: number;
  skeletons: Map<unknown, number>;
  /** The main scene's world-visible lights from this frame's walk: the lighting section's fallback. */
  visibleLights: Light[];
  /** The lights three projected for the main pass (`lightsNode.getLights()`), or null when none was read. */
  lights: LightInfo[] | null;
  /** The first main-pass scene submission was seen: its lights node read, or found missing. */
  lightsRead: boolean;
  startedAt: number;
}

/** A blank record: `SubmissionRecord`'s properties in its order (what `snapshotRecord` copies), then the ledger's own. */
export function newRecord(): PooledRecord {
  return {
    name: '',
    kind: 'other',
    material: 0,
    materialType: '',
    programHash: '',
    variantHash: '',
    transparent: false,
    pass: '',
    reason: 'unclassified',
    flags: [],
    expectedGpuDraws: 0,
    instances: 0,
    instancesDrawn: 0,
    vertices: 0,
    bones: 0,
    skeleton: null,
    morphTargets: 0,
    backSide: false,
  };
}

export function acquire(buffer: RecordBuffer): PooledRecord {
  if (buffer.acquired === buffer.records.length) buffer.records.push(newRecord());
  return buffer.records[buffer.acquired++]!;
}

/** A copy of a pooled record for `frame({ items: true })`: the `SubmissionRecord` fields, with a flags array of its own. */
export function snapshotRecord(record: PooledRecord): SubmissionRecord {
  const { backSide: _backSide, ...copy } = record;
  copy.flags = [...record.flags];
  return copy;
}

/** The state of a frame that just opened, writing `buffer` from its first record. */
export function newFrameState(
  buffer: RecordBuffer,
  drawCallsStart: number,
  trianglesStart: number,
  startedAt: number,
): FrameState {
  return {
    mainScene: null,
    buffer,
    count: 0,
    descriptions: new Map(),
    drawCallsStart,
    trianglesStart,
    shadowCameras: new Map(),
    passIds: new Set(),
    shadowTexels: 0,
    shadowCasters: 0,
    unsupportedObjects: 0,
    lastShadowPass: null,
    scannedScenes: new Set(),
    nestedScenes: 0,
    skeletons: new Map(),
    visibleLights: [],
    lights: null,
    lightsRead: false,
    startedAt,
  };
}
