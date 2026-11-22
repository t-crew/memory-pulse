// A replacement releases a withdrawn term only on its own line. Written on 0.16.1 (2026-10-23, never merged), ported onto 0.18.0
// (2026-11-21), where the hole was still open. A replacement used to release the term anywhere in the edit, so a stranger's
// "| Pro | $49/mo |" passed beside "<!-- coupon: $29 -->" two lines down. A comparison names old and new together; a line that
// names only the old value is a reintroduction, whatever the rest of the file says.

// Every place `needle` stands in `line`, as [start, end).
function spans(line, needle) {
  const out = [];
  if (!needle) return out;
  for (let i = line.indexOf(needle); i !== -1; i = line.indexOf(needle, i + 1)) out.push([i, i + needle.length]);
  return out;
}
// A replacement that is only a piece of a longer occurrence of the withdrawn term is not the replacement being used:
// with "v2.1" corrected to "v2", the "v2" in "uses v2.1" is the old value. Found 2026-11-21: such corrections never blocked.
const insideLonger = (r, termSpans) => termSpans.some(([a, b]) => a <= r[0] && r[1] <= b && b - a > r[1] - r[0]);

/**
 * Is `term` written bare somewhere in `text`: on a line that does not also hold one of its replacements?
 * `has(text, term)` is the guard's token match (server.mjs containsTerm). A replacement is matched as a substring, and it
 * counts only where it stands outside a longer occurrence of the term. With no replacement recorded, any occurrence is bare.
 */
export function bareTerm(text, term, replacement = [], has = (t, x) => String(t).includes(x)) {
  const reps = (Array.isArray(replacement) ? replacement : []).filter((r) => typeof r === "string" && r);
  if (!reps.length) return has(String(text ?? ""), term);
  return String(text ?? "").split("\n").some((line) => {
    if (!has(line, term)) return false;
    const termSpans = spans(line, term);
    return !reps.some((rep) => spans(line, rep).some((r) => !insideLonger(r, termSpans)));
  });
}
