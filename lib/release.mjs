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
 * Is `term` written bare somewhere in `text`: on a line (for a term that spans lines, on the lines it covers) that does not
 * also hold one of its replacements?
 * `has(text, term)` is the guard's token match (server.mjs containsTerm). A replacement is matched as a substring, and it
 * counts only where it stands outside a longer occurrence of the term. With no replacement recorded, any occurrence is bare.
 */
export function bareTerm(text, term, replacement = [], has = (t, x) => String(t).includes(x)) {
  const reps = (Array.isArray(replacement) ? replacement : []).filter((r) => typeof r === "string" && r);
  const all = String(text ?? "");
  if (!reps.length) return has(all, term);
  return units(all, String(term ?? "")).some((unit) => {
    if (!has(unit, term)) return false;
    const termSpans = spans(unit, term);
    return !reps.some((rep) => spans(unit, rep).some((r) => !insideLonger(r, termSpans)));
  });
}
// What the release rule is judged on. A term on one line: each line of the text. A term that spans lines: for each place it
// stands, the whole lines it covers, as one unit. Splitting into lines first found a two-line term on no line, so with a
// replacement recorded it never blocked (review G-5, 2026-11-21).
function units(text, term) {
  if (!term.includes("\n")) return text.split("\n");
  const out = [];
  for (const [a, b] of spans(text, term)) {
    const from = text.lastIndexOf("\n", a - 1) + 1, nl = text.indexOf("\n", b);
    out.push(text.slice(from, nl < 0 ? text.length : nl));
  }
  return out;
}
