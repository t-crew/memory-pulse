# Contributing a rule or a pack

A pack is one JSONL file in this folder: a header line, then one rule per line.

```
{"name":"my-stack","version":"1.0.0","description":"One line.","stack":"my-stack"}
{"id":"old-call","statement":"old_call() was removed in 2.0","patterns":["/\\bold_call\\(/"],"paths":["**/*.py"],"severity":"block","replacement":"new_call()","source":"https://vendor.example/changelog#2-0","verified":"2026-11-21"}
```

A rule is accepted when it has all five:

1. **A vendor source.** `source` is the URL of the vendor's own documentation, changelog or deprecation page, and that page states the removal, the deprecation or the replacement. Not a blog post, not an answer site, not memory.
2. **The date you read it.** `verified` is the day you opened that page and read the sentence. Re-read the page and re-date the rule whenever you touch it.
3. **A fixture that must hit and one that must not.** One line in `fixtures/<pack>.jsonl`: `{"rule","path","hit","miss"}`. The miss is the modern form, plus any near neighbour the pattern must leave alone. `npm test` runs both through the guard's own check.
4. **Measured hits.** Run `memory-pulse pack check <pack> <repo>` over two or three well-known public repositories for the stack, read the hits, and add the rule's row to `MEASURED.md`: hits, true, false, how many you read, and the repositories with their commits. Read every hit of a block rule.
5. **A path scope.** `paths` holds globs (`**/*.py`, `app/**/*.tsx`). A glob that starts with `!` takes paths out.

Severity is a mark, not what happens on install: a pack never blocks by default, and every rule warns until a project turns blocking on (`pack add <name> --block`, `pack rule <pack>/<rule> block`).

- `block` marks a rule safe to block with. Use it only when the vendor's page says removed or not supported, in every version the vendor still fixes bugs in; nothing restores it under the same name; the pattern is specific to it inside `paths`; no corpus hit is false; and it does not block the near misses you can write for it (a version guard, another library's symbol of the same spelling, the project's own name). Add those near misses to `fixtures/near-misses.jsonl`. A marked rule skips comments and strings in code by itself.
- `warn` for everything else: deprecated but still running, removed only in the newest major, a name another library also uses. When in doubt, `warn`, or leave the rule out. A false block costs more than a missing rule. `"mentions": "skip"` makes a warn rule ignore comments and strings in code too.

Patterns are `/regex/flags` or a verbatim substring of four characters or more. Use the `m` flag with `^` and `$`. Bound every wildcard (`[^\n]{0,200}`, never `.*` after a literal). `memory-pulse pack verify <file>` refuses a pattern that matches the empty string, or that uses more than 250 ms of processor time on a line built from its own characters (64 and 100,000 long), and a glob with more than three `*` in one path segment.

Before a pull request, run `memory-pulse pack verify packs/<pack>.jsonl` and `npm test`. The linter runs over every bundled pack, and a rule without a fixture or a `MEASURED.md` row fails the suite. A pack has 4 to 12 rules. Wording is plain: what changed, in which version, what to use.
