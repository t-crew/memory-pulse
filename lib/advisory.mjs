// An ambient single word is advisory (0.17.1): a withdrawn term that is one word of letters only AND was written by
// ambient capture, never by a person. The guard does not block on it; since 0.17.2 the brief and the per-prompt and
// per-edit slices do not lead with it either, because a line about a word the guard no longer enforces is noise.
// The guard's cached rows carry no tags, so there the cause ambient capture writes identifies the row.
export function advisoryTerm(row, term) {
  if (typeof term !== "string" || !/^\p{L}+$/u.test(term)) return false;
  return Array.isArray(row?.tags) ? row.tags.includes("ambient") : /^user-correction-/.test(String(row?.cause ?? ""));
}
/** every withdrawn term of the row is advisory: nothing in it is enforced */
export const allAdvisory = (row) => { const w = Array.isArray(row?.withdrawn) ? row.withdrawn : typeof row?.withdrawn === "string" && row.withdrawn ? [row.withdrawn] : []; return w.length > 0 && w.every((t) => advisoryTerm(row, t)); };
