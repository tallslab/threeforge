// Shared between bench-app/submit.ts (building the id the page submits) and scripts/bench-schema.mjs (checking
// that a submitted id actually matches its own createdAt and env, so a forged id can't misfile a result or
// impersonate another device). Node and the browser both run this file as-is; no build step.

/** FNV-1a over the strings that identify a device, as 8 base-36 characters. */
export function hash8(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h.toString(36) + 'zzzzzzzz').slice(0, 8);
}

/**
 * `YYYY-MM-DD-<hash of gpu, ua, backend>`: the file name under bench/devices. `day` is the calendar date the
 * result was created (a result's `createdAt.slice(0, 10)`, or `now.toISOString().slice(0, 10)` when building one).
 */
export function computeResultId(env, day) {
  return `${day}-${hash8(`${env.gpu}|${env.ua}|${env.backend}`)}`;
}
