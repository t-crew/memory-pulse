// Reading a unified diff. One rule, shared by `check --diff`, the pull-request Action and `pack check --diff`: a file header is
// known by where it stands (between `diff --git` and the first `@@`), never by its first characters. An added line whose own text
// begins with `++` (a pre-increment, a Markdown line of plus signs) is printed by git as `+++...`, and code that skipped every
// `+++` line left it unread (review 2026-11-22, N-A4).

/** Added lines of a unified diff, as one text: what the change introduces. */
export function addedLines(diff) {
  const out = []; let inHunk = false;
  for (const l of String(diff ?? "").split("\n")) {
    if (l.startsWith("diff --git ")) { inHunk = false; continue; }
    if (l.startsWith("@@")) { inHunk = true; continue; }
    if (inHunk && l.startsWith("+")) out.push(l.slice(1));
  }
  return out.join("\n");
}
