import { BackSide, Color, DirectionalLight, Float32BufferAttribute, Fog, HemisphereLight, Mesh, MeshBasicMaterial, SphereGeometry, Vector3, type Scene, type Texture } from 'three';
import { tag } from '../tags.js';

export interface DayNightColors {
  dayZenith: number;
  dayHorizon: number;
  nightZenith: number;
  nightHorizon: number;
  sunDay: number;
  sunLow: number;
  moon: number;
  ground: number;
}

export interface DayNightShadowOptions {
  mapSize?: number;
  /** Half-extent of the sun's orthographic shadow camera. */
  extent?: number;
  near?: number;
  far?: number;
  /** Re-render the shadow map only when the sun moved this many degrees since the last render; 0 = every frame. */
  everyDegrees?: number;
}

export interface DayNightOptions {
  /** Use this light as the sun instead of creating one. */
  sun?: DirectionalLight;
  sunIntensity?: number;
  /** Distance of the sun from the origin. */
  distance?: number;
  /** The gradient sky dome; `{ radius }` sets its size (default 900). */
  dome?: boolean | { radius?: number };
  hemisphere?: boolean;
  /** `true` (default): drive `scene.fog` when the scene has one; `{ near, far }` adds a Fog; `false` leaves fog alone. */
  fog?: boolean | { near: number; far: number };
  /** Follow the sky with `scene.background` (default true). */
  background?: boolean;
  /** `false` for no shadow; otherwise the sun casts with these settings. */
  shadow?: false | DayNightShadowOptions;
  colors?: Partial<DayNightColors>;
}

const DEFAULT_COLORS: DayNightColors = { dayZenith: 0x5c8fd6, dayHorizon: 0xbfd7ff, nightZenith: 0x070b1a, nightHorizon: 0x1a2140, sunDay: 0xfff1e0, sunLow: 0xff9a4a, moon: 0x8fa3c8, ground: 0x5a4a3a };

const _zenith = new Color();
const _horizon = new Color();
const _tmp = new Color();
const _v = new Vector3();

/**
 * One sun, a gradient sky dome, a hemisphere light, fog and background that follow the time of day. `setTime(hours)`
 * moves the sun (rise at 6, set at 18), sets its intensity and colour, lerps the sky palette into the dome's vertex
 * colours, the hemisphere, the fog and the background, and asks for a shadow-map render only when the sun moved
 * at least `everyDegrees`: a slow day cycle re-renders shadows a few times a minute instead of every frame.
 */
export class DayNight {
  readonly sun: DirectionalLight;
  readonly dome: Mesh | null;
  readonly hemisphere: HemisphereLight | null;
  private readonly scene: Scene;
  private readonly colors: DayNightColors;
  private readonly distance: number;
  private readonly sunIntensity: number;
  private readonly ownSun: boolean;
  private readonly driveFog: boolean;
  private readonly driveBackground: boolean;
  private readonly everyDegrees: number;
  private readonly previous: { fog: Scene['fog']; background: Scene['background']; fogColor: Color | null };
  private readonly heights: Float32Array | null;
  /** The zenith and horizon the dome's vertex colours were last written from; NaN until the first write (and after `refreshDome()`), so it always happens. */
  private readonly lastZenith = new Color(Number.NaN, Number.NaN, Number.NaN);
  private readonly lastHorizon = new Color(Number.NaN, Number.NaN, Number.NaN);
  private lastShadowAngle = Number.NaN;
  private angle = 0;
  private hours = 12;

  constructor(scene: Scene, options: DayNightOptions = {}) {
    this.scene = scene;
    this.colors = { ...DEFAULT_COLORS, ...options.colors };
    this.distance = options.distance ?? 200;
    this.sunIntensity = options.sunIntensity ?? 3;
    this.driveBackground = options.background ?? true;
    this.previous = { fog: scene.fog, background: scene.background, fogColor: scene.fog ? scene.fog.color.clone() : null };
    // Own the background colour so the caller's object is never mutated and comes back untouched on dispose.
    if (this.driveBackground) scene.background = new Color();
    const fog = options.fog ?? true;
    if (typeof fog === 'object') scene.fog = new Fog(0x000000, fog.near, fog.far);
    this.driveFog = fog !== false && scene.fog !== null;

    this.ownSun = !options.sun;
    this.sun = options.sun ?? new DirectionalLight(0xffffff, this.sunIntensity);
    if (this.ownSun) {
      this.sun.name = 'sun';
      scene.add(this.sun, this.sun.target);
    }
    const shadow = options.shadow ?? {};
    this.everyDegrees = shadow ? (shadow.everyDegrees ?? 0.5) : 0;
    if (shadow) {
      const size = shadow.mapSize ?? 2048;
      const extent = shadow.extent ?? 140;
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(size, size);
      const cam = this.sun.shadow.camera;
      cam.left = cam.bottom = -extent;
      cam.right = cam.top = extent;
      cam.near = shadow.near ?? 1;
      cam.far = shadow.far ?? 400;
      cam.updateProjectionMatrix();
      this.sun.shadow.autoUpdate = this.everyDegrees === 0;
      this.sun.shadow.needsUpdate = true;
    }

    const dome = options.dome ?? true;
    if (dome) {
      const radius = typeof dome === 'object' ? (dome.radius ?? 900) : 900;
      const geometry = new SphereGeometry(radius, 24, 12);
      const position = geometry.getAttribute('position');
      this.heights = new Float32Array(position.count);
      for (let i = 0; i < position.count; i++) this.heights[i] = (position.getY(i) / radius + 1) / 2;
      geometry.setAttribute('color', new Float32BufferAttribute(new Float32Array(position.count * 3), 3));
      const material = new MeshBasicMaterial({ vertexColors: true, side: BackSide, fog: false, depthWrite: false, toneMapped: false });
      this.dome = new Mesh(geometry, material);
      // Named rather than marked: the static tag owns `userData.forge`.
      // Culling stays on: the dome surrounds the camera, so its sphere always intersects the frustum, and the
      // compiler then treats it as a plain static singleton (frozen, one submission).
      this.dome.name = 'sky-dome';
      tag.static(this.dome);
      scene.add(this.dome);
    } else {
      this.dome = null;
      this.heights = null;
    }

    if (options.hemisphere ?? true) {
      this.hemisphere = new HemisphereLight(0xffffff, this.colors.ground, 0.6);
      this.hemisphere.name = 'sky';
      scene.add(this.hemisphere);
    } else this.hemisphere = null;

    this.setTime(12);
  }

  get time(): number {
    return this.hours;
  }

  /** Sine of the sun's angle above the horizon: 1 at noon, 0 at 6 and 18, −1 at midnight. */
  get elevation(): number {
    return Math.sin(this.angle);
  }

  setTime(hours: number): void {
    this.hours = hours;
    const a = ((hours - 6) / 24) * Math.PI * 2;
    this.angle = a;
    const elevation = Math.sin(a);
    const d = this.distance;
    this.sun.position.set(Math.cos(a) * d, Math.max(20, elevation * d), 0.3 * d);
    this.sun.updateMatrixWorld();
    const up = Math.max(0, elevation);
    this.sun.intensity = Math.max(0.05, elevation) * this.sunIntensity;
    if (elevation >= 0) this.sun.color.setHex(this.colors.sunLow).lerp(_tmp.setHex(this.colors.sunDay), Math.min(1, elevation * 2));
    else this.sun.color.setHex(this.colors.moon);

    _zenith.setHex(this.colors.nightZenith).lerp(_tmp.setHex(this.colors.dayZenith), up);
    _horizon.setHex(this.colors.nightHorizon).lerp(_tmp.setHex(this.colors.dayHorizon), up);
    // Only the dome's vertex colours are skipped, and only when both ends of the gradient are exactly what they were
    // written from: everything above (the sun's place, intensity and colour) and below (hemisphere, fog, background,
    // the shadow refresh) runs on every call.
    if (this.dome && this.heights && !(this.lastZenith.equals(_zenith) && this.lastHorizon.equals(_horizon))) {
      const colors = this.dome.geometry.getAttribute('color') as Float32BufferAttribute;
      const array = colors.array as Float32Array;
      for (let i = 0; i < this.heights.length; i++) {
        const h = this.heights[i]!;
        const t = Math.min(1, Math.max(0, (h - 0.35) / 0.65));
        const k = t * t * (3 - 2 * t);
        array[i * 3] = _horizon.r + (_zenith.r - _horizon.r) * k;
        array[i * 3 + 1] = _horizon.g + (_zenith.g - _horizon.g) * k;
        array[i * 3 + 2] = _horizon.b + (_zenith.b - _horizon.b) * k;
      }
      colors.needsUpdate = true;
      this.lastZenith.copy(_zenith);
      this.lastHorizon.copy(_horizon);
    }
    if (this.hemisphere) {
      this.hemisphere.color.copy(_zenith).lerp(_horizon, 0.5);
      this.hemisphere.intensity = 0.2 + 0.5 * up;
    }
    if (this.driveFog && this.scene.fog) this.scene.fog.color.copy(_horizon);
    if (this.driveBackground) {
      const background = this.scene.background as Color | Texture | null;
      if (background && (background as Color).isColor) (background as Color).copy(_horizon);
    }
    if (this.sun.castShadow && this.everyDegrees > 0) {
      const step = (this.everyDegrees * Math.PI) / 180;
      if (Number.isNaN(this.lastShadowAngle) || Math.abs(a - this.lastShadowAngle) >= step - 1e-9) {
        this.sun.shadow.needsUpdate = true;
        this.lastShadowAngle = a;
      }
    }
  }

  /** Force one shadow-map render (after `world.markDirty`, for example). */
  refreshShadow(): void {
    this.sun.shadow.needsUpdate = true;
    this.lastShadowAngle = this.angle;
  }

  /**
   * Drops the dome's colour cache, so the next `setTime()` writes its vertex colours again whatever the palette.
   * `dome` is public: call this after writing to its colour attribute or swapping its geometry yourself, or the
   * cache would leave what you wrote in place for an unchanged sky.
   */
  refreshDome(): void {
    this.lastZenith.setRGB(Number.NaN, Number.NaN, Number.NaN);
    this.lastHorizon.setRGB(Number.NaN, Number.NaN, Number.NaN);
  }

  /** Removes what the instance added and restores the scene's fog and background. */
  dispose(): void {
    if (this.ownSun) {
      this.sun.removeFromParent();
      this.sun.target.removeFromParent();
      this.sun.dispose();
    }
    if (this.dome) {
      this.dome.removeFromParent();
      this.dome.geometry.dispose();
      (this.dome.material as MeshBasicMaterial).dispose();
    }
    if (this.hemisphere) {
      this.hemisphere.removeFromParent();
      this.hemisphere.dispose();
    }
    this.scene.fog = this.previous.fog;
    if (this.scene.fog && this.previous.fogColor) this.scene.fog.color.copy(this.previous.fogColor);
    this.scene.background = this.previous.background;
    _v.set(0, 0, 0);
  }
}
