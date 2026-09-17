import type { Scene } from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { PMREMGenerator, type WebGPURenderer } from 'three/webgpu';

/** three's RoomEnvironment as the scene's environment map, prefiltered once. */
export function applyRoomEnvironment(renderer: WebGPURenderer, scene: Scene, intensity?: number): void {
  const room = new RoomEnvironment();
  const pmrem = new PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(room, 0.04).texture;
  if (intensity !== undefined) scene.environmentIntensity = intensity;
  pmrem.dispose();
  room.dispose();
}
