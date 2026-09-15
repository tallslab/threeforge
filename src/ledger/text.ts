/**
 * Names (mesh/light/material names from a glTF asset, or a scene an app built) and hint messages that reach a
 * frame snapshot come from a scene graph threeforge does not control. A single unbounded name — or a hint whose
 * message embeds one — can otherwise balloon a JSON document an agent reads. These caps bound that; they are not
 * sanitization (stripping ANSI/control/bidi characters is a CLI-boundary concern, see `src/cli/untrusted.ts`,
 * which additionally guards content that never passes through this library at all, such as a raw page snapshot
 * from `inspect`).
 */

/** Cap for a single name: an item name in `byReason[reason].top`, or a hint's `objects` entries. */
export const MAX_NAME_LENGTH = 120;

/** Cap for a hint's `message`, after any name has already been interpolated into it. */
export const MAX_MESSAGE_LENGTH = 300;

/**
 * Truncates `s` to at most `max` Unicode code points (not UTF-16 units), so a cut never lands inside a
 * surrogate pair and turns an astral character (an emoji) into an invalid lone surrogate. A truncated string
 * ends with a single `…`, itself counted inside `max`. Strings already within budget are returned unchanged
 * (the common case), without the cost of splitting into code points.
 */
function capCodePoints(s: string, max: number): string {
  if (s.length <= max) return s; // UTF-16 length is always >= code point count, so this is a safe fast path.
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  return chars.slice(0, Math.max(0, max - 1)).join('') + '…';
}

/** Caps a name at `MAX_NAME_LENGTH` characters. */
export function capName(name: string): string {
  return capCodePoints(name, MAX_NAME_LENGTH);
}

/** Caps a message at `MAX_MESSAGE_LENGTH` characters. */
export function capMessage(message: string): string {
  return capCodePoints(message, MAX_MESSAGE_LENGTH);
}
