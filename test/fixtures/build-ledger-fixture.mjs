#!/usr/bin/env node
// Builds test/fixtures/ledger-1700.jsonl from a real ledger's tail with every piece of its text replaced, so a public repo
// carries the ledger's SHAPE (kinds, structural tags, supersedes, rollbacks, term counts, note lengths) and none of its words.
// Usage: node test/fixtures/build-ledger-fixture.mjs <source events.jsonl> [out] [n=1700]
import { readFileSync, writeFileSync } from "node:fs";

const [src, out = new URL("./ledger-1700.jsonl", import.meta.url).pathname, n = "1700"] = process.argv.slice(2);
if (!src) { console.error("usage: build-ledger-fixture.mjs <source events.jsonl> [out] [n]"); process.exit(1); }
const STRUCTURAL = new Set(["identity", "rule", "state", "decision", "open", "todo", "handoff", "rollback", "ambient", "preference", "lesson"]);
const WORDS = "alpha bravo carbon delta ember fjord glade harbor indigo juniper kestrel lumen meadow nimbus orchid pylon quartz ripple summit tundra umber vertex willow xenon yarrow zephyr".split(" ");
const lorem = (len, seed) => { let s = "", i = seed; while (s.length < len) s += WORDS[i++ % WORDS.length] + " "; return s.slice(0, len).trim(); };
const slug = (orig, t, role) => `${role}-${t}-${lorem(Math.min(30, String(orig ?? "").length), t).replace(/\s+/g, "-")}`;
const rows = readFileSync(src, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((r) => r && typeof r === "object" && Number.isInteger(r.t)).slice(-Number(n));
const scrubbed = rows.map((r) => {
  const o = { t: r.t, cause: slug(r.cause, r.t, "c"), effect: slug(r.effect, r.t, "e") };
  if (r.kind && r.kind !== "event") o.kind = r.kind;
  if (r.note) o.note = lorem(String(r.note).length, r.t);
  const tags = (Array.isArray(r.tags) ? r.tags : []).filter((x) => STRUCTURAL.has(x)); if (tags.length) o.tags = tags;
  if (r.pinned) o.pinned = true;
  if (Array.isArray(r.withdrawn)) o.withdrawn = r.withdrawn.map((_, i) => `w${r.t}x${i}`);
  if (Array.isArray(r.replacement)) o.replacement = r.replacement.map((_, i) => `r${r.t}x${i}`);
  if (Array.isArray(r.supersedes)) o.supersedes = r.supersedes;
  if (Number.isInteger(r.rollback_to)) o.rollback_to = r.rollback_to;
  return o;
});
writeFileSync(out, scrubbed.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`wrote ${scrubbed.length} scrubbed rows to ${out}`);
