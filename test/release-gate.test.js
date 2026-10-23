// The release runs the IP gate over exactly what npm publishes, and stops before anything leaves the machine when it fails.
// Added 2026-10-22 (red first): ip-gate's --publish mode had scanned 3 of the 19 shipped files, and release.sh never ran it, so a comment
// naming an engine technique shipped in lib/scaffold.mjs from 0.7.0 to 0.15.0.
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Edited after the first (red) run: the order check reads executable lines only, because the script's header comment names git push and
// wrangler deploy before any step runs. The assertions are unchanged.
const sh = readFileSync(new URL("../scripts/release.sh", import.meta.url), "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

test("release.sh runs ip-gate --publish, fails closed, and does so before any push, tag or deploy", () => {
  const gate = sh.search(/ip-gate\.mjs"? --publish/);
  assert.ok(gate > 0, "release.sh must run ip-gate.mjs --publish");
  const after = sh.slice(gate, gate + 300);
  assert.match(after, /exit 1/, "a failing or missing gate must stop the release");
  for (const step of ["git push", "git tag", "npm publish", "wrangler deploy"]) {
    const at = sh.indexOf(step);
    assert.ok(at === -1 || gate < at, `the gate must run before ${step}`);
  }
});
