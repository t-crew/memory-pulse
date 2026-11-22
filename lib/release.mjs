// A replacement releases a withdrawn term only on its own line. Written on 0.16.1 (2026-10-23, never merged), ported onto 0.18.0
// (2026-11-21), where the hole was still open. A replacement used to release the term anywhere in the edit, so a stranger's
// "| Pro | $49/mo |" passed beside "<!-- coupon: $29 -->" two lines down. A comparison names old and new together; a line that
// names only the old value is a reintroduction, whatever the rest of the file says.

/**
 * Is `term` written bare somewhere in `text`: on a line that does not also hold one of its replacements?
 * `has(text, term)` is the guard's token match (server.mjs containsTerm); a replacement is matched as a substring, as before.
 * With no replacement recorded, any occurrence is bare.
 */
export function bareTerm(text, term, replacement = [], has = (t, x) => String(t).includes(x)) {
  const reps = (Array.isArray(replacement) ? replacement : []).filter((r) => typeof r === "string" && r);
  if (!reps.length) return has(String(text ?? ""), term);
  return String(text ?? "").split("\n").some((line) => has(line, term) && !reps.some((r) => line.includes(r)));
}
