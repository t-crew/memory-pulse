// Is a withdrawn term specific enough to block on? One rule, used wherever the client decides that by itself:
// what ambient capture writes (heardOnly), what the guard reads from rows ambient capture wrote before (lib/advisory.mjs),
// the caution `remember` returns for a person's own word (broadCaution), and the noisy label in `report` and the brief.
//
// Measured, 2026-11-21. On one real ledger, 125 of the 166 term blocks recorded between 2026-09-01 and 2026-11-20 came
// from seven ambient corrections whose term this rule calls not specific; the other 41 came from terms it calls specific,
// and no term a person recorded falls on the not-specific side.
//
// The rule is the one 0.17.1 set for reading ambient rows: one word of letters only is not specific, whatever its capitals.
// The first version of this module also called a camelCase name and a capital word of three letters or more specific, on
// the median share of files such a word sits in (0.20% and 0.34% of 5,917 files, against 7.2% for a lowercase word). The
// median hid the words people name in a correction. An independent review the same day counted them in a fixed sample of
// 3,000 files: JSON 14.9%, API 8.6%, URL 7.0%, forEach 4.1%, toString 3.9%, HTTP 2.8%, HTML 2.3%, TODO 2.1%, README 1.9%,
// against 6.1% for "merge", the word whose 85 blocks this module was written to stop. So capitals do not count.

/** One word of letters only, as 0.17.1 tested it (no trimming: a stored term is already trimmed). */
export const lettersOnly = (term) => typeof term === "string" && /^\p{L}+$/u.test(term);

/**
 * A number by itself: digits, with dots or commas between them and nothing else. As broad as an ordinary word: "48" stands in
 * 10.3% of a 3,000-file sample (second review, 2026-11-22, N-G2). With a unit, a symbol or a word beside it ($49, v2.1, 48 tests,
 * 3/11) it is specific.
 */
export const bareNumber = (term) => typeof term === "string" && /^\d+(?:[.,]\d+)?$/.test(term);   // 48, 6144, 0.030, 6,144; a version (0.18.0) has two dots and is specific

/** How a message names what the term is: a word or a number. */
export const broadKind = (term) => (bareNumber(String(term)) ? "a number by itself" : "one ordinary word");

/** What capture must not enforce by itself: one word of letters only, or a number by itself. */
export const broadTerm = (term) => lettersOnly(term) || bareNumber(term);

/** A term the guard can block on without blocking ordinary prose: two or more words, a digit or a symbol. One word of letters only is not, whatever its capitals. */
export function isSpecificTerm(term) {
  if (typeof term !== "string") return false;
  const s = term.trim();
  return s.length > 0 && !broadTerm(s);
}

const slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "term";
const q = (t) => `"${String(t).replace(/"/g, "'")}"`;

/** The command that records the literal word on purpose. Its cause is not the one ambient capture writes, so the guard enforces the row. */
export function enforceCommand(withdrawn, replacement) {
  const w = String(withdrawn), r = replacement ? String(replacement) : "";
  return `memory-pulse remember deliberate-${slug(w)} ${r ? `${slug(w)}-withdrawn-for-${slug(r)}` : `${slug(w)}-withdrawn`} --kind correction --withdrawn ${q(w)}${r ? ` --replacement ${q(r)}` : ""}`;
}

/**
 * What ambient capture writes for a correction it heard. A row whose withdrawn terms are all specific is returned as it is.
 * Otherwise the row keeps what was heard and binds nothing: no withdrawn terms, a note that says so and why, and the command
 * that enforces the word. One ordinary word as a withdrawn term blocks every edit that contains it.
 */
export function heardOnly(row, prompt = "") {
  const terms = Array.isArray(row?.withdrawn) ? row.withdrawn : [];
  if (!terms.length || terms.every(isSpecificTerm)) return row;
  const w = terms.find((t) => !isSpecificTerm(t)), r = Array.isArray(row.replacement) && row.replacement.length ? row.replacement[0] : null;
  const { withdrawn: _w, replacement: _r, ...rest } = row;
  const heard = r ? `Heard ${q(w)} corrected to ${q(r)}` : `Heard a prohibition of ${q(w)}`;
  const said = String(prompt).replace(/\s+/g, " ").trim().slice(0, 140).replace(/"/g, "'");
  return { ...rest, effect: `${slug(w)}-heard-not-enforced`,
    note: `${heard}. Not enforced: ${q(w)} is ${broadKind(w)}, and blocking it would block every edit that contains it. Enforced on purpose with: ${enforceCommand(w, r)}${said ? `. Prompt: "${said}"` : ""}` };
}

/** The line the observe hook prints for a row heardOnly left unenforced. */
export const heardLine = (t, withdrawn, replacement) => `memory-pulse: heard ${q(withdrawn)} (t=${t}), not enforced: ${broadKind(withdrawn)} would block every edit that contains it. To enforce it: ${enforceCommand(withdrawn, replacement)}`;

/** One caution line for a person's own `remember --withdrawn <word>`: the row binds, and this says how wide it is. Null when every term is specific. */
export function broadCaution(withdrawn) {
  const broad = (Array.isArray(withdrawn) ? withdrawn : []).filter((t) => typeof t === "string" && t.trim() && !isSpecificTerm(t));
  if (!broad.length) return null;
  const names = broad.map(q), list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${list} ${broad.length === 1 ? `is ${broadKind(broad[0])}: the guard blocks every edit that contains it` : "are each one ordinary word: the guard blocks every edit that contains one"}. To let it through under one path: memory-pulse guard allow ${names[0]} --path <prefix> "<reason>"`;
}

// ---- A noisy rule (report, and the brief's AT RISK block). A correction the guard blocks often in one place is doing its
// work. One ordinary word blocked in many places is a rule that is too wide: on one real ledger the two noisiest rows were
// such words, 85 blocks in 62 directories and 16 in 14, and every specific term stayed under 12 blocks in 9 directories.
/** Blocks at or above this count as often. */
export const NOISY_MIN_BLOCKS = 5;
/** Distinct directories at or above this count as widely. */
export const NOISY_MIN_DIRS = 3;

/** Blocked often, in many places, and the term is one ordinary word. */
export const isNoisy = ({ term, blocks, dirs }) => blocks >= NOISY_MIN_BLOCKS && dirs >= NOISY_MIN_DIRS && typeof term === "string" && !!term.trim() && !isSpecificTerm(term);

/** Per correction, from the violation records: how many blocks, in how many distinct directories, and the term hit most. Map keyed by t, most blocked first. */
export function blockStats(blocks) {
  const byT = new Map();
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (!b || !Array.isArray(b.hits)) continue;
    const dir = String(b.file ?? "").split("/").slice(0, -1).join("/") || ".";
    for (const h of b.hits) {
      const t = Number(h?.t); if (!Number.isInteger(t)) continue;
      const m = byT.get(t) ?? { t, n: 0, places: new Set(), terms: new Map() };
      m.n++; m.places.add(dir); m.terms.set(h.term, (m.terms.get(h.term) ?? 0) + 1); byT.set(t, m);
    }
  }
  return new Map([...byT.values()].sort((a, b) => b.n - a.n).map((m) => [m.t, { t: m.t, blocks: m.n, dirs: m.places.size, term: [...m.terms].sort((a, b) => b[1] - a[1])[0][0] }]));
}

/** The label with both ways out, on one line; "" when the correction is not noisy. `advisory`: the guard no longer blocks the term (lib/advisory.mjs). */
export function noisyLine({ t, term, blocks, dirs, advisory = false }) {
  if (!isNoisy({ term, blocks, dirs })) return "";
  return `noisy: ${q(term)} (t${t}) is ${broadKind(term)}, blocked ${blocks} times in ${dirs} directories${advisory ? " (advisory now: ambient capture wrote it, so the guard no longer blocks it)" : ""}. Retire it: memory-pulse remember <cause> <effect> --kind correction --supersedes ${t}. Or scope it: memory-pulse guard allow ${q(term)} --path <prefix> "<reason>"`;
}
