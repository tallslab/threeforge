import { MAX_MESSAGE_LENGTH } from '../ledger/text.js';
import { EnvironmentError, PageError, UsageError } from './errors.js';

/**
 * Cleans text that came from a glTF asset or a page the CLI does not control before it reaches a terminal or an
 * agent's JSON document. A page can return a hint message hundreds of kilobytes long (an "IGNORE ALL PREVIOUS
 * INSTRUCTIONS" text, say); it is bounded and cleaned before it reaches the document or the terminal.
 *
 * `cleanText` handles one string: a name, a stderr line, a page error. `sanitizeDeep` walks an arbitrary
 * `page.evaluate` result that *resolved* (the whole thing is untrusted for `inspect`, whose target is any page,
 * not necessarily one using threeforge's own capping in `src/ledger/text.ts`). `describeError` covers the other
 * half of that same threat model: a `page.evaluate` (or `waitForFunction`) that *rejects* — a hook that throws
 * inside `compile()`/`frameAsync()`, or a getter that throws when read — carries page text through an exception,
 * not a resolved value, so it needs its own cleaning at every sink that prints or returns an error.
 *
 * Neither function is a substitute for treating the values as data: see the MCP "data, not instructions" note in
 * `src/cli/mcp.ts`.
 */

/** CSI (`ESC [ params intermediate final`), OSC (`ESC ] ... BEL` or `ESC ] ... ESC \`), and other Fe escape sequences. */
const ANSI = /[\x1B\x9B](?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])/g;

/**
 * Invisible characters, useless in a name or a message except to disguise text:
 * - every format character (`\p{Cf}`): bidi marks, overrides and isolates (U+061C, U+200E-200F, U+202A-202E,
 *   U+2066-2069), zero-width characters (U+200B-200D, U+2060-2064, U+FEFF), the soft hyphen, the deprecated format
 *   controls U+206A-206F, interlinear annotation U+FFF9-FFFB, and the Unicode tag characters U+E0001 and
 *   U+E0020-E007F, which mirror ASCII invisibly and are read by LLM tokenizers ("ASCII smuggling");
 * - the rest of the tag block (U+E0000-E007F, unassigned code points included);
 * - variation selectors (U+FE00-FE0F, U+E0100-E01EF) and the Mongolian ones (U+180B-180D, U+180F), which can carry
 *   hidden bytes after a visible glyph;
 * - characters that draw nothing although not `Cf`: the combining grapheme joiner U+034F, the Hangul fillers U+115F,
 *   U+1160, U+3164 and U+FFA0, and the Khmer inherent vowels U+17B4-17B5.
 */
const INVISIBLE = /[\p{Cf}\u{E0000}-\u{E007F}\uFE00-\uFE0F\u{E0100}-\u{E01EF}\u180B-\u180D\u180F\u034F\u115F\u1160\u3164\uFFA0\u17B4\u17B5]/gu;

/**
 * C0 controls (incl. tab/newline/CR/ESC), DEL, C1 controls, and the Unicode line and paragraph separators U+2028-2029.
 * Collapsing a line break to a space blocks fake log lines.
 */
const CONTROL = /[\x00-\x1F\x7F-\x9F\u2028\u2029]/g;

/** A cap generous enough for a normal CLI line, small enough to bound a hostile one. */
export const DEFAULT_TEXT_MAX = 2000;

/**
 * Strips ANSI escapes and invisible characters (`INVISIBLE`: format, tag and variation-selector characters, among
 * them the zero-width and bidi ones), replaces remaining control characters (including embedded newlines) with a
 * space, then caps the result at `max` Unicode code points — never splitting a surrogate pair, so an astral emoji
 * within budget survives whole. A non-string is returned unchanged (defensive: `sanitizeDeep` is the only caller that
 * can hand this something other than a string).
 */
export function cleanText(s: string, max: number = DEFAULT_TEXT_MAX): string {
  if (typeof s !== 'string') return s;
  const cleaned = s.replace(ANSI, '').replace(INVISIBLE, '').replace(CONTROL, ' ');
  if (cleaned.length <= max) return cleaned; // UTF-16 length >= code point count: a safe fast path.
  const chars = Array.from(cleaned);
  if (chars.length <= max) return cleaned;
  return chars.slice(0, Math.max(0, max - 1)).join('') + '…';
}

/** Cleans a possibly multi-line block of text one line at a time, so the newlines that give it structure survive. */
export function cleanLines(text: string, max: number = DEFAULT_TEXT_MAX): string {
  return text
    .split('\n')
    .map((line) => cleanText(line, max))
    .join('\n');
}

export interface SanitizeOptions {
  /**
   * Cap per string, in Unicode code points (default `MAX_MESSAGE_LENGTH`, 300): the ledger's own cap on a hint message,
   * so a message it kept whole is not cut again here, losing its actionable tail.
   */
  maxString?: number;
  /** Cap per array, in elements; a longer array gets one extra `"(+N more)"` marker appended (default 256). */
  maxArray?: number;
  /** Cap on how many levels of arrays/objects are walked before a placeholder replaces the rest (default 16). */
  maxDepth?: number;
}

const SANITIZE_DEFAULTS: Required<SanitizeOptions> = { maxString: MAX_MESSAGE_LENGTH, maxArray: 256, maxDepth: 16 };

/**
 * Recursively cleans a value that came from `page.evaluate`: every string through `cleanText`, every non-finite
 * number (`NaN`, `Infinity`, `-Infinity`, none of which JSON can represent) replaced with `0`, arrays and plain
 * objects capped in length/depth, and circular references broken instead of recursing forever. Functions, symbols
 * and `bigint` become `undefined` (dropped by `JSON.stringify`, same as today). Booleans, `null` and finite
 * numbers pass through unchanged.
 *
 * `0`, not `null`, for a non-finite number: `SNAPSHOT_SCHEMA` (`src/cli/schema.ts`) declares fields such as
 * `totals.sceneSubmissions`, `js.renderMs` and `js.frameMs` as non-nullable numbers, and this value can reach one
 * of them directly (`measure.ts` assigns `result.snapshot.js.renderMs = result.renderMs`) — `null` there would be
 * schema-invalid.
 */
export function sanitizeDeep(value: unknown, options: SanitizeOptions = {}): unknown {
  const opts: Required<SanitizeOptions> = { ...SANITIZE_DEFAULTS, ...options };
  return sanitizeAt(value, opts, 0, new WeakSet<object>());
}

function sanitizeAt(value: unknown, opts: Required<SanitizeOptions>, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return cleanText(value, opts.maxString);
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return undefined; // undefined, function, symbol, bigint
  if (seen.has(value)) return '[circular]';
  if (depth >= opts.maxDepth) return '[max depth]';
  seen.add(value);
  if (Array.isArray(value)) {
    const kept = value.slice(0, opts.maxArray).map((item) => sanitizeAt(item, opts, depth + 1, seen));
    // The "(+N more)" marker is itself a string: only safe to append when every element already was one (a
    // schema whose array items must all be a particular object shape, e.g. FrameSnapshot.hints: Hint[], would
    // become invalid with a bare string tacked on) — other arrays are truncated silently instead.
    if (value.length > opts.maxArray && value.every((item) => typeof item === 'string')) kept.push(`(+${value.length - opts.maxArray} more)`);
    return kept;
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) out[cleanText(key, opts.maxString)] = sanitizeAt(v, opts, depth + 1, seen);
  return out;
}

/** How many page errors `formatPageErrors` keeps, and how long each kept one may be. */
export const PAGE_ERRORS_MAX = 5;
export const PAGE_ERROR_LENGTH_MAX = 300;

/** The first `PAGE_ERRORS_MAX` page errors, each cleaned and capped at `PAGE_ERROR_LENGTH_MAX`, joined for a log line; a `(+N more)` suffix names the rest. */
export function formatPageErrors(errors: readonly string[]): string {
  const shown = errors.slice(0, PAGE_ERRORS_MAX).map((e) => cleanText(e, PAGE_ERROR_LENGTH_MAX));
  const extra = errors.length - shown.length;
  return extra > 0 ? `${shown.join(' | ')} (+${extra} more)` : shown.join(' | ');
}

/**
 * The line a CLI command's top-level catch writes to stderr (`index.ts`) for a failed run, and what `mcp.ts`'s
 * `fail()` puts in its JSON `error` field — cleaned and capped the same way as everything else here. A page's
 * text can reach an error message not only through a *resolved* `page.evaluate` value (which `sanitizeDeep`
 * already covers end to end) but through a *rejected* one — `evaluateWithin` and `waitFor` (`measure.ts`) both
 * wrap that rejection in a `PageError` with a cleaned message, but describing it for a human or an agent is a
 * second, separate formatting step that must not skip the cleaning too.
 */
export function describeError(error: unknown): string {
  const message = cleanText(error instanceof Error ? error.message : String(error));
  if (error instanceof UsageError) return message;
  if (error instanceof EnvironmentError) return `environment: ${message}`;
  if (error instanceof PageError) return `page: ${message}`;
  const detail = error instanceof Error && error.stack ? cleanText(error.stack) : message;
  return `error: ${detail}`;
}
