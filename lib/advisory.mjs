// An ambient single word is advisory (0.17.1): a withdrawn term that is one word of letters only AND was written by
// ambient capture, never by a person. The guard does not block on it; since 0.17.2 the brief and the per-prompt and
// per-edit slices do not lead with it either, because a line about a word the guard no longer enforces is noise.
// The guard's cached rows carry no tags, so there the cause ambient capture writes identifies the row.
// "One word of letters only" is lettersOnly (lib/specific.mjs), the test this function had in 0.17.1 and 0.18.0. For one
// day in a development branch it was narrowed so that an ambient camelCase name or acronym was enforced again; a review
// showed JSON in 14.9% of files and the 0.17.1 rule was put back unchanged (2026-11-21). A ledger written by 0.18.0 is
// read exactly as 0.18.0 read it.
// Since 0.19.0 a number by itself is advisory too when capture wrote it (bareNumber): the one case where a ledger written by
// 0.18.0 reads differently, and only towards fewer blocks.
import { broadTerm } from "./specific.mjs";
export function advisoryTerm(row, term) {
  if (!broadTerm(term)) return false;
  return Array.isArray(row?.tags) ? row.tags.includes("ambient") : /^user-correction-/.test(String(row?.cause ?? ""));
}
/** every withdrawn term of the row is advisory: nothing in it is enforced */
export const allAdvisory = (row) => { const w = Array.isArray(row?.withdrawn) ? row.withdrawn : typeof row?.withdrawn === "string" && row.withdrawn ? [row.withdrawn] : []; return w.length > 0 && w.every((t) => advisoryTerm(row, t)); };
