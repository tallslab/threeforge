/**
 * Shadow pass ids: a pure function of a scene's shadow-casting lights, in scene order, and the ids the frame has
 * already handed out to its other scenes. The ledger keeps the frame state this reads and writes — the set of ids
 * taken and the shadow camera → pass map — so the naming rules themselves can be tested without a renderer.
 */

/** What a shadow pass id is built from: the light's name, else its type. */
interface ShadowPassLight {
  name: string;
  type: string;
}

/**
 * One pass id per light of `lights`, in the same order: `shadow:<name>` (the type when the light has no name) for a
 * name no other shadow-casting light of the scene has, `shadow:<name>#k` (k from 1, in scene order) for a shared one.
 * An id another scene of the frame already took moves on to the next free k. Numbering is per scene, so a light whose
 * name is unique in its own scene asks for the bare id first however many numbered ones another scene took.
 *
 * Every id handed out is added to `taken`, which is how the next scene of the frame sees them.
 */
export function shadowPassIds(lights: readonly ShadowPassLight[], taken: Set<string>): string[] {
  const shared = new Map<string, number>();
  for (const light of lights) {
    const key = light.name || light.type;
    shared.set(key, (shared.get(key) ?? 0) + 1);
  }
  const numbered = new Map<string, number>();
  const ids: string[] = [];
  for (const light of lights) {
    const key = light.name || light.type;
    const base = `shadow:${key}`;
    const duplicate = shared.get(key)! > 1;
    let k = duplicate ? (numbered.get(key) ?? 0) + 1 : 1;
    let id = duplicate ? `${base}#${k}` : base;
    while (taken.has(id)) id = `${base}#${++k}`;
    numbered.set(key, k);
    taken.add(id);
    ids.push(id);
  }
  return ids;
}
