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

export function capName(name: string): string {
  return capCodePoints(name, MAX_NAME_LENGTH);
}

export function capMessage(message: string): string {
  return capCodePoints(message, MAX_MESSAGE_LENGTH);
}

/** A count for a panel or table: `120k`, `6.4k`, `1.0M`; below a thousand the rounded integer. */
export function formatCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(n));
}

/** Bytes as whole MiB with no unit, so a row of values can name `MB` once. */
export function formatBytes(bytes: number): string {
  return String(Math.round(bytes / (1024 * 1024)));
}

/** `error` as one line for a status field: its message, or with `'stack'` its stack trace when it has one. */
export function describeError(error: unknown, detail: 'message' | 'stack' = 'message'): string {
  if (!(error instanceof Error)) return String(error);
  return detail === 'stack' ? (error.stack ?? error.message) : error.message;
}
