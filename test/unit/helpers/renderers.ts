import { WebGLCoordinateSystem } from 'three';

/** What a culling hook reads from the renderer three hands `onBeforeRender`: the coordinate system alone. */
export const webglRenderer = { coordinateSystem: WebGLCoordinateSystem };
