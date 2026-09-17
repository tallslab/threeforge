import {
  LineBasicMaterial,
  LineDashedMaterial,
  Material,
  MeshBasicMaterial,
  MeshDepthMaterial,
  MeshDistanceMaterial,
  MeshLambertMaterial,
  MeshMatcapMaterial,
  MeshNormalMaterial,
  MeshPhongMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  MeshToonMaterial,
  PointsMaterial,
  RawShaderMaterial,
  ShaderMaterial,
  ShadowMaterial,
  SpriteMaterial,
} from 'three';
import {
  Line2NodeMaterial,
  LineBasicNodeMaterial,
  LineDashedNodeMaterial,
  MeshBasicNodeMaterial,
  MeshLambertNodeMaterial,
  MeshMatcapNodeMaterial,
  MeshNormalNodeMaterial,
  MeshPhongNodeMaterial,
  MeshPhysicalNodeMaterial,
  MeshSSSNodeMaterial,
  MeshStandardNodeMaterial,
  MeshToonNodeMaterial,
  NodeMaterial,
  PointsNodeMaterial,
  ShadowNodeMaterial,
  SpriteNodeMaterial,
  VolumeNodeMaterial,
} from 'three/webgpu';

/**
 * three r186's own material classes: the 18 classic ones of `src/materials/Materials.js` and the 17 node ones of
 * `src/materials/nodes/NodeMaterials.js`.
 */
const BUILT_IN_MATERIAL_PROTOTYPES: ReadonlySet<object> = new Set<object>(
  [
    LineBasicMaterial,
    LineDashedMaterial,
    Material,
    MeshBasicMaterial,
    MeshDepthMaterial,
    MeshDistanceMaterial,
    MeshLambertMaterial,
    MeshMatcapMaterial,
    MeshNormalMaterial,
    MeshPhongMaterial,
    MeshPhysicalMaterial,
    MeshStandardMaterial,
    MeshToonMaterial,
    PointsMaterial,
    RawShaderMaterial,
    ShaderMaterial,
    ShadowMaterial,
    SpriteMaterial,
    Line2NodeMaterial,
    LineBasicNodeMaterial,
    LineDashedNodeMaterial,
    MeshBasicNodeMaterial,
    MeshLambertNodeMaterial,
    MeshMatcapNodeMaterial,
    MeshNormalNodeMaterial,
    MeshPhongNodeMaterial,
    MeshPhysicalNodeMaterial,
    MeshSSSNodeMaterial,
    MeshStandardNodeMaterial,
    MeshToonNodeMaterial,
    NodeMaterial,
    PointsNodeMaterial,
    ShadowNodeMaterial,
    SpriteNodeMaterial,
    VolumeNodeMaterial,
  ].map((type) => type.prototype as object),
);

/**
 * Whether a material is exactly an instance of one of three r186's own material classes: its prototype is that class's
 * prototype (`BUILT_IN_MATERIAL_PROTOTYPES`). A subclass fails, because an overridden method (a node material's
 * `setup*`, which builds the shader and can hold `Discard()`, or any other) is code the compiler cannot inspect.
 */
export function isBuiltInMaterial(material: Material): boolean {
  return BUILT_IN_MATERIAL_PROTOTYPES.has(Object.getPrototypeOf(material) as object);
}
