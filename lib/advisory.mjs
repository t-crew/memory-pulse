// An ambient single word is advisory (0.17.1): a withdrawn term that is one word of letters only AND was written by
// ambient capture, never by a person. The guard does not block on it; since 0.17.2 the brief and the per-prompt and
// per-edit slices do not lead with it either, because a line about a word the guard no longer enforces is noise.
// The guard's cached rows carry no tags, so there the cause ambient capture writes identifies the row.
// "One ordinary word" is isSpecificTerm's rule (lib/specific.mjs, measured 2026-11-21): it was "letters only", which also
// let an ambient camelCase name or an acronym of three letters or more through. Those are as rare in files as a value
// with a digit in it, so they are enforced again.
import { isSpecificTerm } from "./specific.mjs";
export function advisoryTerm(row, term) {
  if (typeof term !== "string" || !term.trim() || isSpecificTerm(term)) return false;
  return Array.isArray(row?.tags) ? row.tags.includes("ambient") : /^user-correction-/.test(String(row?.cause ?? ""));
}
/** every withdrawn term of the row is advisory: nothing in it is enforced */
export const allAdvisory = (row) => { const w = Array.isArray(row?.withdrawn) ? row.withdrawn : typeof row?.withdrawn === "string" && row.withdrawn ? [row.withdrawn] : []; return w.length > 0 && w.every((t) => advisoryTerm(row, t)); };
