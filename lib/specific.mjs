// Is a withdrawn term specific enough to block on? One rule, used wherever the client decides that by itself:
// what ambient capture writes (heardOnly), what the guard reads from rows ambient capture wrote before (lib/advisory.mjs),
// the caution `remember` returns for a person's own word (broadCaution), and the noisy label in `report` and the brief.
//
// Measured, 2026-11-21. On one real ledger, 125 of the 166 term blocks recorded between 2026-09-01 and 2026-11-20 came
// from seven ambient corrections whose term this rule calls not specific; the other 41 came from terms it calls specific,
// and no term a person recorded falls on the not-specific side. Over 5,917 files on the same machine, the share of files a
// term of each shape appears in (terms sampled by occurrence, 400 per shape; median, then the share of terms in over 1%
// of files): lowercase word 7.2%, 0.85; Capitalized word 1.2%, 0.55; two-letter capital word 1.3%, 0.73; capital word of
// three letters or more 0.34%, 0.29; camelCase name 0.20%, 0.20; value with a digit or a symbol 0.24%, 0.30.
// So a capital word of three letters or more and a camelCase name are as rare as a value, and a two-letter capital word
// ("TO", "ID") is as common as an ordinary word. The guard matches case-sensitively, which is why capitals count.

/** A term the guard can block on without blocking ordinary prose: two or more words, a digit, a symbol, camelCase, or a capital word of three letters or more. */
export function isSpecificTerm(term) {
  if (typeof term !== "string") return false;
  const s = term.trim();
  if (!s) return false;
  if (/\s/.test(s)) return true;                                   // a phrase
  if (/\p{N}/u.test(s)) return true;                               // a digit
  if (/[^\p{L}\p{M}'’]/u.test(s)) return true;                // a symbol: $ . / _ - : ( ) @ # and the rest (an apostrophe is part of a word)
  if (/\p{Ll}\p{Lu}/u.test(s)) return true;                        // camelCase
  return s.length >= 3 && (s.match(/\p{Lu}/gu) ?? []).length >= 2; // JSON, README, OpenAI; not TO or ID
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
    note: `${heard}. Not enforced: ${q(w)} is one ordinary word, and blocking it would block every edit that contains it. Enforced on purpose with: ${enforceCommand(w, r)}${said ? `. Prompt: "${said}"` : ""}` };
}

/** The line the observe hook prints for a row heardOnly left unenforced. */
export const heardLine = (t, withdrawn, replacement) => `memory-pulse: heard ${q(withdrawn)} (t=${t}), not enforced: one ordinary word would block every edit that contains it. To enforce it: ${enforceCommand(withdrawn, replacement)}`;

/** One caution line for a person's own `remember --withdrawn <word>`: the row binds, and this says how wide it is. Null when every term is specific. */
export function broadCaution(withdrawn) {
  const broad = (Array.isArray(withdrawn) ? withdrawn : []).filter((t) => typeof t === "string" && t.trim() && !isSpecificTerm(t));
  if (!broad.length) return null;
  const names = broad.map(q), list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${list} ${broad.length === 1 ? "is one ordinary word: the guard blocks every edit that contains it" : "are each one ordinary word: the guard blocks every edit that contains one"}. To let it through under one path: memory-pulse guard allow ${names[0]} --path <prefix> "<reason>"`;
}
