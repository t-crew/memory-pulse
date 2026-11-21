// The Action's api-key input: with a key the pull-request check asks the engine for a signed receipt and names it in the comment;
// without a key nothing leaves the runner; an engine that is down never changes the verdict; the engine cannot clear a local block.
// Added 2026-11-21 (red first): action/run.mjs never passed --receipt, so the input did nothing (stranger audit 2026-09-09, re-found 2026-11-21).
// Also here: the release script moves the major tag the docs tell teams to use, and the Marketplace badge colour.
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const servers = [];
after(() => { for (const s of servers) s.close(); });

// A stand-in engine: records each request and answers /v1/check with the verdict it is told to give.
async function engine(verdict = "verified") {
  const seen = [];
  const srv = createServer((req, res) => {
    let raw = ""; req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      seen.push({ url: req.url, key: req.headers["x-mp-key"] ?? null });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ verdict, reasons: [], evidence: [], receipt: { kind: "check", verdict, count: 2, head: "abcdef0123456789abcdef" } }));
    });
  });
  await new Promise((ok, no) => { srv.once("error", no); srv.listen(0, "127.0.0.1", ok); });
  servers.push(srv);
  return { base: `http://127.0.0.1:${srv.address().port}`, seen };
}

// A repository with one correction ($49 withdrawn for $29) and a branch whose diff is `body`.
function repo(body) {
  const dir = mkdtempSync(join(tmpdir(), "mp-action-receipt-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, ".memory-pulse"));
  writeFileSync(join(dir, ".memory-pulse", "events.jsonl"), [
    { t: 1, cause: "pricing-shipped", effect: "price-set", note: "launch price" },
    { t: 2, cause: "pricing-shipped", effect: "price-corrected", kind: "correction", note: "measured willingness to pay is $29", withdrawn: ["$49"], replacement: ["$29"] },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(dir, "pricing.md"), "# Pricing\n\nPro is $29/mo.\n");
  git("add", "-A"); git("commit", "-q", "-m", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("checkout", "-q", "-b", "change");
  writeFileSync(join(dir, "pricing.md"), body);
  git("commit", "-q", "-am", "change");
  return dir;
}

// Runs the Action's runner without blocking this process, so the stand-in engine can answer.
function run(dir, env) {
  const summary = join(dir, "summary.md"); writeFileSync(summary, "");
  return new Promise((done) => {
    execFile(process.execPath, [join(ROOT, "action", "run.mjs")], {
      cwd: dir, encoding: "utf8",
      env: { ...process.env, GITHUB_BASE_REF: "main", GITHUB_STEP_SUMMARY: summary, MEMORY_PULSE_LEDGER: join(dir, ".memory-pulse", "events.jsonl"), GITHUB_TOKEN: "", GITHUB_REPOSITORY: "", MP_ACTION_LINT: "false", MEMORY_PULSE_KEY: "", ...env },
    }, (err, stdout, stderr) => done({ code: err ? err.code : 0, out: stdout + stderr, summary: readFileSync(summary, "utf8") }));
  });
}

const BENIGN = "# Pricing\n\nPro was $49/mo; it is $29/mo now.\n";
const REINTRODUCES = "# Pricing\n\nPro is $49/mo.\n";

test("with a key, the check asks the engine for a receipt, sends the key, and the summary names the receipt", async () => {
  const e = await engine("verified");
  const r = await run(repo(BENIGN), { MEMORY_PULSE_KEY: "mp_test_key", MEMORY_PULSE_API: e.base });
  assert.equal(r.code, 0, r.out);
  assert.ok(e.seen.some((q) => q.url === "/v1/check" && q.key === "mp_test_key"), `the engine was not asked for a receipt: ${JSON.stringify(e.seen)}`);
  assert.match(r.summary, /receipt `check:abcdef012345`/);
});

test("without a key, nothing leaves the runner and no receipt is claimed", async () => {
  const e = await engine("verified");
  const r = await run(repo(BENIGN), { MEMORY_PULSE_KEY: "", MEMORY_PULSE_API: e.base });
  assert.equal(r.code, 0, r.out);
  assert.equal(e.seen.length, 0, `a request left the runner with no key: ${JSON.stringify(e.seen)}`);
  assert.doesNotMatch(r.summary, /receipt/);
});

test("an engine that is down never changes the verdict: a block still blocks, a benign change still passes, and the summary says no receipt was issued", async () => {
  const dead = "http://127.0.0.1:9"; // the discard port: nothing answers
  const blocked = await run(repo(REINTRODUCES), { MEMORY_PULSE_KEY: "mp_test_key", MEMORY_PULSE_API: dead });
  assert.equal(blocked.code, 2, blocked.out);
  assert.match(blocked.summary, /withdrawn at ledger t2/);
  assert.match(blocked.summary, /no receipt was issued/);
  const ok = await run(repo(BENIGN), { MEMORY_PULSE_KEY: "mp_test_key", MEMORY_PULSE_API: dead });
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.summary, /no receipt was issued/);
});

test("the engine cannot clear a local block: the verdict is the one computed on the runner", async () => {
  const e = await engine("verified");
  const r = await run(repo(REINTRODUCES), { MEMORY_PULSE_KEY: "mp_test_key", MEMORY_PULSE_API: e.base });
  assert.equal(r.code, 2, r.out);
  assert.match(r.summary, /memory-pulse blocked this change/);
  assert.match(r.summary, /the engine answered verified/);
});

// The release script and the Action manifest, read as text (executable lines only, as test/release-gate.test.js does).
const sh = readFileSync(new URL("../scripts/release.sh", import.meta.url), "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

test("release.sh moves the major tag (v0) to the release and pushes it, after the version tag and before any worker deploy", () => {
  const versionTag = sh.indexOf('git push -f origin "v$VERSION"');
  const major = sh.search(/git tag -f "v\$MAJOR"/);
  const pushMajor = sh.search(/git push -f origin "v\$MAJOR"/);
  assert.ok(versionTag > 0, "the version tag push is the anchor for this test");
  assert.ok(major > versionTag, "release.sh must re-point v$MAJOR after pushing the version tag");
  assert.ok(pushMajor > major, "release.sh must push the moved major tag");
  assert.match(sh, /MAJOR="\$\{VERSION%%\.\*\}"/, "MAJOR is the part of the version before the first dot");
  const deploy = sh.indexOf("wrangler deploy");
  assert.ok(deploy === -1 || pushMajor < deploy, "the major tag moves before the worker deploy");
});

test("release.sh can release the client without deploying the engine worker", () => {
  const deploy = sh.indexOf("wrangler deploy");
  assert.ok(deploy > 0);
  const guard = sh.lastIndexOf("RELEASE_SKIP_WORKER", deploy);
  assert.ok(guard > 0 && deploy - guard < 400, "the worker deploy sits behind RELEASE_SKIP_WORKER");
});

test("action.yml: the Marketplace badge is not purple, and the api-key input says what it does", () => {
  const yml = readFileSync(new URL("../action.yml", import.meta.url), "utf8");
  assert.match(yml, /branding:\s*\n\s*icon: shield\s*\n\s*color: blue/);
  assert.doesNotMatch(yml, /color: purple/);
  const key = yml.slice(yml.indexOf("api-key:"), yml.indexOf("lint:"));
  assert.match(key, /receipt/i);
  assert.match(key, /Without it nothing leaves the runner/);
});
