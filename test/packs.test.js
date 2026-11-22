// Rule packs (lib/packs.mjs). A pack is one JSONL file: a header line {name, version, description, stack} and one rule per line in
// the invariant shape plus `source` (the vendor page that states the change) and `verified` (the date that page was read). An
// installed pack is its own file, .memory-pulse/packs/<name>.jsonl: it is never appended to invariants.jsonl and never written to
// the ledger. The loader that guard, check and lint share reads it. Local choices live in .memory-pulse/packs/overrides.jsonl, so
// the pack file stays as shipped. `paths` gains globs (an entry with a `*`); an entry without one is a prefix, exactly as before.
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test } from "node:test";
import assert from "node:assert/strict";
for (const k of ["MEMORY_PULSE_LEDGER", "MEMORY_PULSE_PROJECT", "MEMORY_PULSE_KEY", "MEMORY_PULSE_BOARD"]) delete process.env[k];
process.env.MEMORY_PULSE_MODE = "deliberate"; process.env.MEMORY_PULSE_AGENT = "/nonexistent/agent/events.jsonl";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER } from "./_helpers.mjs";
import { localCheck, readInvariants } from "../server.mjs";
import { globMatch, scopeHas, pathInScope, verifyPack, installedPackRules, forEngine } from "../lib/packs.mjs";

const SRC = "https://example.com/demo/changelog#2-0";
const HEADER = { name: "demo-stack", version: "1.0.0", description: "Rules for the demo stack.", stack: "demo" };
const RULES = [
  { id: "old-call", statement: "old_call() was removed in demo 2.0", patterns: ["/\\bold_call\\(/"], paths: ["**/*.py"], severity: "block", replacement: "new_call()", source: SRC, verified: "2026-11-21" },
  { id: "soft-call", statement: "soft_call() is deprecated since demo 1.9", patterns: ["/\\bsoft_call\\(/"], paths: ["**/*.py"], severity: "warn", replacement: "firm_call()", source: "https://example.com/demo/deprecations", verified: "2026-11-20" },
  { id: "app-only", statement: "legacy_fetch is not available under app/", patterns: ["legacy_fetch"], paths: ["app/**/*.tsx"], severity: "block", replacement: "fetch()", source: "https://example.com/demo/app", verified: "2026-11-21" },
];
const packText = (rules = RULES, header = HEADER) => [header, ...rules].map((x) => JSON.stringify(x)).join("\n") + "\n";

// a scratch project and an explicit environment: no MEMORY_PULSE_LEDGER, so nothing here can reach a real ledger or settings file
function project() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "mp-packs-"))); const dir = join(base, "p"); mkdirSync(dir, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: base, TMPDIR: base, NO_COLOR: "1", MEMORY_PULSE_API: "http://127.0.0.1:9", MEMORY_PULSE_AGENT: join(base, "agent.jsonl"), MEMORY_PULSE_MODE: "deliberate",
    MEMORY_PULSE_TRUST_DIR: join(base, "trust"), MEMORY_PULSE_DATA_DIR: join(base, "data") };
  const file = join(base, "demo-stack.jsonl"); writeFileSync(file, packText());
  const cli = (...args) => { const r = spawnSync(process.execPath, [SERVER, ...args], { cwd: dir, env, encoding: "utf8" }); return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}${r.stderr}` }; };
  const guard = (file_path, content) => { const r = spawnSync(process.execPath, [SERVER, "guard"], { cwd: dir, env, encoding: "utf8", input: JSON.stringify({ tool_name: "Write", tool_input: { file_path, content }, cwd: dir }) }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  return { base, dir, env, file, cli, guard, installed: join(dir, ".memory-pulse", "packs", "demo-stack.jsonl"), overrides: join(dir, ".memory-pulse", "packs", "overrides.jsonl") };
}
const tmpPack = (text, name = "x.jsonl") => { const d = mkdtempSync(join(tmpdir(), "mp-packfile-")); const f = join(d, name); writeFileSync(f, text); return f; };

// ---- paths: globs are new, prefixes behave exactly as they did
test("a `paths` entry with a `*` is a glob: extension and directory globs, at any depth where `**` says so", () => {
  for (const p of ["a.py", "src/a.py", "src/x/y/a.py"]) assert.equal(globMatch("**/*.py", p), true, p);
  for (const p of ["a.pyc", "a.py.txt", "py", "src/a.pyx"]) assert.equal(globMatch("**/*.py", p), false, p);
  for (const p of ["app/page.tsx", "app/a/b/page.tsx"]) assert.equal(globMatch("app/**/*.tsx", p), true, p);
  for (const p of ["src/app/page.tsx", "apps/page.tsx", "app/page.ts", "myapp/page.tsx"]) assert.equal(globMatch("app/**/*.tsx", p), false, p);
  for (const p of ["app/page.tsx", "src/app/x/route.ts", "packages/web/app/layout.ts"]) assert.equal(globMatch("**/app/**/*.{ts,tsx}", p), true, p);
  assert.equal(globMatch("**/app/**/*.{ts,tsx}", "src/app/page.jsx"), false);
  for (const p of ["wrangler.toml", "workers/api/wrangler.toml"]) assert.equal(globMatch("**/wrangler.toml", p), true, p);
  assert.equal(globMatch("**/wrangler.toml", "wrangler.toml.bak"), false);
  assert.equal(globMatch("src/*.js", "src/a.js"), true); assert.equal(globMatch("src/*.js", "src/x/a.js"), false, "a single * stays inside one path segment");
  assert.equal(globMatch("docs/**", "docs/a/b.md"), true); assert.equal(globMatch("docs/**", "notdocs/a.md"), false);
  assert.equal(globMatch("**/v?/*.py", "api/v1/a.py"), true); assert.equal(globMatch("**/v?/*.py", "api/v10/a.py"), false);
  // brackets and parentheses are literal, as in a Next.js route folder
  assert.equal(globMatch("app/[slug]/**/*.tsx", "app/[slug]/page.tsx"), true); assert.equal(globMatch("app/[slug]/**/*.tsx", "app/s/page.tsx"), false);
  assert.equal(globMatch("**/*.py", "./src/a.py"), true, "a leading ./ is dropped"); assert.equal(globMatch("**/*.py", "src\\a.py"), true, "backslashes read as slashes");
});

test("a glob is matched against the project-relative form of an absolute path (Claude Code sends absolute paths)", () => {
  const cwd = process.cwd();
  assert.equal(globMatch("app/**/*.tsx", join(cwd, "app", "x", "page.tsx")), true);
  assert.equal(globMatch("app/**/*.tsx", join(cwd, "src", "app", "page.tsx")), false, "relative to the project, this is src/app/…");
  assert.equal(globMatch("**/*.py", "/somewhere/else/a.py"), true, "outside the project, `**/` still reaches the file");
  assert.equal(globMatch("app/**/*.tsx", "/somewhere/else/app/page.tsx"), false, "outside the project, a rooted glob does not match");
});

test("a `paths` entry without a `*` is a prefix, exactly as before: startsWith on the path as given", () => {
  assert.equal(scopeHas("docs/", "docs/a.md"), true);
  assert.equal(scopeHas("docs/", "src/docs/a.md"), false);
  assert.equal(scopeHas("README.md", "README.md.bak"), true, "a prefix, not a file name");
  assert.equal(scopeHas("docs/", join(process.cwd(), "docs", "a.md")), false, "a prefix is not made project-relative: unchanged from 0.18.0");
  assert.equal(scopeHas("app/[slug]/", "app/[slug]/page.tsx"), true); assert.equal(scopeHas("app/[slug]/", "app/s/page.tsx"), false, "brackets never become a pattern");
  assert.equal(scopeHas("src/a?.js", "src/ab.js"), false, "a ? without a * is a literal prefix character");
  assert.equal(scopeHas("**/*.py", "src/a.py"), true); assert.equal(scopeHas("**/*.py", "src/a.js"), false);
});

test("a glob entry that starts with ! takes paths out of scope; without a * it is still a prefix", () => {
  const app = ["app/**/*.{ts,tsx}", "src/app/**/*.{ts,tsx}", "!**/pages/**"];
  assert.equal(pathInScope(app, "app/shop/page.tsx"), true);
  assert.equal(pathInScope(app, "src/app/layout.tsx"), true);
  assert.equal(pathInScope(app, "app/pages/index.tsx"), false, "a Pages Router project that lives in a folder named app");
  assert.equal(pathInScope(app, "lib/x.tsx"), false);
  const code = ["**/*.py", "!**/tests/**", "!**/test_*.py"];
  assert.equal(pathInScope(code, "src/llm.py"), true);
  assert.equal(pathInScope(code, "tests/unit/x.py"), false); assert.equal(pathInScope(code, "pkg/tests/x.py"), false); assert.equal(pathInScope(code, "src/test_llm.py"), false);
  assert.equal(pathInScope(code, join(process.cwd(), "tests", "x.py")), false, "an absolute path is excluded by its project-relative form");
  assert.equal(pathInScope(["!**/vendor/**"], "src/a.js"), true, "only exclusions: every other path is in scope");
  assert.equal(pathInScope(["!**/vendor/**"], "vendor/a.js"), false);
  assert.equal(pathInScope([], "anything"), true);
  // 0.18.0 behaviour for an entry with no *: a prefix, whatever its first character
  assert.equal(pathInScope(["!notes/"], "!notes/a.md"), true); assert.equal(pathInScope(["!notes/"], "notes/a.md"), false);
  assert.equal(pathInScope(["docs/", "site/"], "site/index.html"), true); assert.equal(pathInScope(["docs/", "site/"], "src/site/index.html"), false);
  const inv = [{ id: "no-tests", patterns: ["FORBIDDEN"], paths: ["**/*.py", "!**/tests/**"] }];
  const ids = (path) => localCheck([], { kind: "edit", text: "x FORBIDDEN y", path }, inv).invariants.map((h) => h.id);
  assert.deepEqual(ids("src/a.py"), ["no-tests"]); assert.deepEqual(ids("tests/a.py"), []);
  // the linter wants one glob that puts paths in scope
  const v = verifyPack(tmpPack(packText([{ ...RULES[0], paths: ["!**/tests/**"] }])));
  assert.equal(v.ok, false); assert.ok(v.errors.some((e) => /old-call: .*paths/.test(e)), v.errors.join(" | "));
  assert.equal(verifyPack(tmpPack(packText([{ ...RULES[0], paths: ["**/*.py", "!**/tests/**"] }]))).ok, true);
});

test("localCheck: prefix-scoped invariants match as in 0.18.0, and a glob-scoped one matches by extension and directory", () => {
  const inv = [
    { id: "docs-only", statement: "not in the docs", patterns: ["FORBIDDEN"], paths: ["docs/"] },
    { id: "py-only", statement: "not in python", patterns: ["FORBIDDEN"], paths: ["**/*.py"] },
    { id: "app-tsx", statement: "not in app", patterns: ["FORBIDDEN"], paths: ["app/**/*.tsx"], severity: "warn" },
    { id: "anywhere", patterns: ["EVERYWHERE"] },
  ];
  const ids = (path, text = "x FORBIDDEN y") => localCheck([], { kind: "edit", text, path }, inv).invariants.map((h) => h.id);
  assert.deepEqual(ids("docs/a.md"), ["docs-only"]);
  assert.deepEqual(ids("src/docs/a.md"), []);
  assert.deepEqual(ids(""), [], "no path: a scoped rule does not fire, as before");
  assert.deepEqual(ids("pull-request"), [], "the Action's path: a scoped rule does not fire, as before");
  assert.deepEqual(ids("src/a.py"), ["py-only"]);
  assert.deepEqual(ids("docs/tool.py"), ["docs-only", "py-only"]);
  assert.deepEqual(ids("app/x/page.tsx"), ["app-tsx"]);
  assert.deepEqual(ids("lib/page.tsx"), []);
  assert.deepEqual(ids("anything.txt", "EVERYWHERE"), ["anywhere"], "an unscoped rule fires on every path, as before");
});

// ---- the pack file and its linter
test("pack verify: a well-formed pack passes, with its header and rule count", () => {
  const v = verifyPack(tmpPack(packText()));
  assert.deepEqual(v.errors, []); assert.equal(v.ok, true);
  assert.equal(v.header.name, "demo-stack"); assert.equal(v.rules.length, 3);
});

test("pack verify refuses a rule without an id, a compiling pattern, a source URL, a verified date, or a replacement or statement", () => {
  const bad = (patch, drop = []) => { const r = { ...RULES[0], ...patch }; for (const k of drop) delete r[k]; return verifyPack(tmpPack(packText([r]))); };
  const refuses = (v, re) => { assert.equal(v.ok, false); assert.ok(v.errors.some((e) => re.test(e)), `expected ${re} in:\n${v.errors.join("\n")}`); };
  refuses(bad({}, ["id"]), /line 2: .*\bid\b/);
  refuses(bad({ id: "Has Space" }), /line 2: .*\bid\b/);
  refuses(bad({ patterns: [] }), /old-call: .*pattern/);
  refuses(bad({ patterns: ["/(unclosed/"] }), /old-call: .*does not compile/);
  refuses(bad({}, ["source"]), /old-call: .*source/);
  refuses(bad({ source: "see the changelog" }), /old-call: .*source/);
  refuses(bad({ source: "http://example.com/x" }), /old-call: .*source.*https/);
  refuses(bad({}, ["verified"]), /old-call: .*verified/);
  refuses(bad({ verified: "last week" }), /old-call: .*verified/);
  refuses(bad({ verified: "2026-02-31" }), /old-call: .*verified/);
  refuses(bad({ verified: "2999-01-01" }), /old-call: .*verified.*future/);
  refuses(bad({}, ["statement", "replacement"]), /old-call: .*statement.*replacement|old-call: .*replacement.*statement/);
  refuses(bad({ severity: "fatal" }), /old-call: .*severity/);
  refuses(bad({}, ["severity"]), /old-call: .*severity/);
  refuses(bad({}, ["paths"]), /old-call: .*paths/);
  refuses(bad({ paths: ["src/"] }), /old-call: .*paths.*glob/);
  refuses(bad({ on: "command" }), /old-call: .*command/);
  // one rule with only a statement, or only a replacement, is accepted
  assert.equal(bad({}, ["replacement"]).ok, true); assert.equal(bad({}, ["statement"]).ok, true);
});

test("pack verify refuses a broken header, a torn line and a repeated rule id", () => {
  const refuses = (text, re) => { const v = verifyPack(tmpPack(text)); assert.equal(v.ok, false); assert.ok(v.errors.some((e) => re.test(e)), `expected ${re} in:\n${v.errors.join("\n")}`); };
  refuses(RULES.map((x) => JSON.stringify(x)).join("\n") + "\n", /line 1: .*header/);
  refuses(packText(RULES, { ...HEADER, name: "Demo Stack" }), /header: .*name/);
  refuses(packText(RULES, { ...HEADER, name: "overrides" }), /header: .*name/);
  refuses(packText(RULES, { ...HEADER, version: "one" }), /header: .*version/);
  refuses(packText(RULES, { ...HEADER, description: "" }), /header: .*description/);
  refuses(packText(RULES, { name: "demo-stack", version: "1.0.0", description: "d" }), /header: .*stack/);
  refuses(packText() + "{not json\n", /line 5: .*JSON/);
  refuses(packText([RULES[0], RULES[0]]), /line 3: .*old-call.*twice|line 3: .*repeat/);
  refuses(JSON.stringify(HEADER) + "\n", /no rules/);
});

test("pack verify refuses a pattern that matches the empty string", () => {
  for (const p of ["/x*/", "/(foo)?/", "/^\\s*$/m", "/\\b/"]) {
    const v = verifyPack(tmpPack(packText([{ ...RULES[0], patterns: [p] }])));
    assert.equal(v.ok, false, p); assert.ok(v.errors.some((e) => /old-call: .*empty string/.test(e)), `${p}: ${v.errors.join(" | ")}`);
  }
  const short = verifyPack(tmpPack(packText([{ ...RULES[0], patterns: ["ab"] }])));
  assert.equal(short.ok, false); assert.ok(short.errors.some((e) => /old-call: .*at least 4 characters/.test(e)), short.errors.join(" | "));
});

test("pack verify refuses a pattern that takes too long on a long line, and comes back in bounded time", () => {
  const t0 = Date.now();
  // exponential backtracking, and a quadratic scan: an unbounded .* after a literal that repeats on the line
  for (const p of ["/(a+)+$/", "/old_call.*never_there/"]) {
    const v = verifyPack(tmpPack(packText([{ ...RULES[0], patterns: [p] }, RULES[1]])));
    assert.equal(v.ok, false, p); assert.ok(v.errors.some((e) => /old-call: .*too long on a long line/.test(e)), `${p}: ${v.errors.join(" | ")}`);
    assert.ok(!v.errors.some((e) => /soft-call/.test(e)), "the rule after a slow one is still checked, and passes");
  }
  // the bounded form of the same rule passes
  const ok = verifyPack(tmpPack(packText([{ ...RULES[0], patterns: ["/old_call[^\\n]{0,80}never_there/"] }])));
  assert.deepEqual(ok.errors, []);
  assert.ok(Date.now() - t0 < 40000, `verify took ${Date.now() - t0} ms`);
});

// ---- installing: its own file, never the invariants file, never the ledger
test("pack add <path> installs the pack as its own committed file, byte for byte, and writes nothing else", () => {
  const p = project();
  const r = p.cli("pack", "add", p.file);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /installed demo-stack 1\.0\.0: 3 rules \(2 block, 1 warn\)/);
  assert.match(r.out, /\.memory-pulse\/packs\/demo-stack\.jsonl/);
  assert.equal(readFileSync(p.installed, "utf8"), readFileSync(p.file, "utf8"));
  assert.deepEqual(readdirSync(join(p.dir, ".memory-pulse")), ["packs"], "no ledger, no invariants.jsonl, no sidecar");
  assert.deepEqual(readdirSync(join(p.dir, ".memory-pulse", "packs")), ["demo-stack.jsonl"]);
});

test("pack add refuses a pack that fails the linter, an unknown name, and anything that looks like a URL", () => {
  const p = project();
  const bad = tmpPack(packText([{ ...RULES[0], source: "" }]), "demo-stack.jsonl");
  const r = p.cli("pack", "add", bad);
  assert.equal(r.code, 1); assert.match(r.all, /old-call: .*source/); assert.equal(existsSync(p.installed), false);
  const u = p.cli("pack", "add", "no-such-pack");
  assert.equal(u.code, 1); assert.match(u.all, /no pack named "no-such-pack"/); assert.match(u.all, /pack list/);
  const n = p.cli("pack", "add", "https://example.com/pack.jsonl");
  assert.equal(n.code, 1); assert.match(n.all, /not fetched from the network/);
  assert.equal(existsSync(join(p.dir, ".memory-pulse")), false, "a refused add leaves nothing behind");
});

test("the shared loader reads installed packs beside the declared invariants; a path given by the caller reads that file alone", () => {
  const p = project(); p.cli("pack", "add", p.file);
  writeFileSync(join(p.dir, ".memory-pulse", "invariants.jsonl"), JSON.stringify({ id: "mine", statement: "declared by hand", patterns: ["HANDRULE"] }) + "\n");
  const rules = installedPackRules(join(p.dir, ".memory-pulse", "packs"));
  assert.deepEqual(rules.map((r) => r.id), ["demo-stack/old-call", "demo-stack/soft-call", "demo-stack/app-only"]);
  assert.equal(rules[0].pack.name, "demo-stack"); assert.equal(rules[0].pack.rule, "old-call"); assert.equal(rules[0].pack.source, SRC); assert.equal(rules[0].pack.verified, "2026-11-21");
  const cwd = process.cwd(); process.chdir(p.dir);
  try {
    assert.deepEqual(readInvariants().map((r) => r.id), ["mine", "demo-stack/old-call", "demo-stack/soft-call", "demo-stack/app-only"], "declared rules first, then packs");
    assert.deepEqual(readInvariants(join(p.dir, ".memory-pulse", "invariants.jsonl")).map((r) => r.id), ["mine"], "an explicit path (a capsule's) carries no pack rule");
  } finally { process.chdir(cwd); }
  // both kinds of rule are enforced by one check
  const c = p.cli("check", "--text", "HANDRULE and old_call(1)", "--path", "src/a.py");
  assert.match(c.out, /BLOCKED/); assert.match(c.out, /invariant mine: declared by hand/); assert.match(c.out, /pack demo-stack, rule old-call/);
});

// ---- enforcement: the block names the pack, the rule, the replacement, the source and the override
test("guard blocks an edit that a pack's block rule matches, and the message names pack, rule, replacement, source and the override", () => {
  const p = project(); p.cli("pack", "add", p.file);
  for (const path of ["src/a.py", join(p.dir, "src", "a.py")]) {
    const g = p.guard(path, "x = old_call(1)\n");
    assert.equal(g.code, 2, `${path}: ${g.err}`);
    assert.match(g.err, /memory-pulse guard: blocked\./);
    assert.ok(g.err.includes("pack demo-stack, rule old-call: old_call() was removed in demo 2.0 (matched /\\bold_call\\(/) — instead: new_call(). Source: https://example.com/demo/changelog#2-0 (read 2026-11-21)"), g.err);
    assert.match(g.err, /memory-pulse pack rule demo-stack\/old-call warn/);
    assert.match(g.err, /memory-pulse pack rule demo-stack\/old-call off/);
    assert.match(g.err, /\.memory-pulse\/packs\/demo-stack\.jsonl/);
    assert.doesNotMatch(g.err, /invariants\.jsonl/, "a pack rule is not described as a line of invariants.jsonl");
    assert.doesNotMatch(g.err, /an override does not apply/);
  }
  // out of the rule's path scope, and a clean edit in scope: silent
  for (const [path, text] of [["src/a.js", "x = old_call(1)"], ["src/a.py", "x = new_call(1)"], ["lib/page.tsx", "legacy_fetch()"]]) {
    const g = p.guard(path, text); assert.equal(g.code, 0, g.err); assert.equal(g.out, ""); assert.equal(g.err, "");
  }
  assert.equal(p.guard("app/shop/page.tsx", "legacy_fetch()").code, 2, "the directory glob scopes the third rule to app/");
  assert.equal(p.guard(join(p.dir, "app", "page.tsx"), "legacy_fetch()").code, 2);
});

test("guard shows a pack's warn rule to the agent as context and does not block", () => {
  const p = project(); p.cli("pack", "add", p.file);
  const g = p.guard(join(p.dir, "src", "a.py"), "y = soft_call(2)\n");
  assert.equal(g.code, 0, g.err);
  const ctx = JSON.parse(g.out).hookSpecificOutput;
  assert.equal(ctx.hookEventName, "PreToolUse"); assert.equal(ctx.permissionDecision, undefined, "the guard never answers allow for the user");
  assert.match(ctx.additionalContext, /not blocked/);
  assert.ok(ctx.additionalContext.includes("warning pack demo-stack, rule soft-call: soft_call() is deprecated since demo 1.9 (matched /\\bsoft_call\\(/) — instead: firm_call(). Source: https://example.com/demo/deprecations (read 2026-11-20)"), ctx.additionalContext);
  assert.match(g.err, /warning pack demo-stack, rule soft-call/, "the same line is on stderr for the person reading the transcript");
});

test("check --ci and lint report a pack hit with the same line, and a warn rule does not turn the verdict", () => {
  const p = project(); p.cli("pack", "add", p.file);
  mkdirSync(join(p.dir, "src")); writeFileSync(join(p.dir, "src", "a.py"), "x = old_call(1)\n"); writeFileSync(join(p.dir, "src", "b.py"), "y = soft_call(2)\n");
  const c = p.cli("check", "--ci", "--file", "src/a.py");
  assert.equal(c.code, 2); assert.match(c.out, /memory-pulse check: BLOCKED/); assert.match(c.out, /pack demo-stack, rule old-call: .*instead: new_call\(\)\. Source: https:\/\/example\.com\/demo\/changelog#2-0 \(read 2026-11-21\)/);
  const w = p.cli("check", "--file", "src/b.py");
  assert.doesNotMatch(w.out, /BLOCKED/); assert.match(w.out, /warning pack demo-stack, rule soft-call/);
  const l = p.cli("lint", "src/a.py", "src/b.py");
  assert.match(l.out, /BLOCKED\s+src\/a\.py/); assert.match(l.out, /pack demo-stack, rule old-call/); assert.doesNotMatch(l.out, /BLOCKED\s+src\/b\.py/);
});

// ---- the project-level override: one rule to warn or off, the pack file untouched
test("pack rule <pack>/<id> warn|off|block|default changes one rule for this project without editing the pack file", () => {
  const p = project(); p.cli("pack", "add", p.file);
  const shipped = readFileSync(p.installed, "utf8");
  const edit = () => p.guard("src/a.py", "x = old_call(1)\n");
  assert.equal(edit().code, 2);
  const w = p.cli("pack", "rule", "demo-stack/old-call", "warn", "--reason", "the 1.x branch still calls it");
  assert.equal(w.code, 0, w.all); assert.match(w.out, /demo-stack\/old-call: block -> warn/); assert.match(w.out, /overrides\.jsonl/);
  let g = edit(); assert.equal(g.code, 0); assert.match(JSON.parse(g.out).hookSpecificOutput.additionalContext, /warning pack demo-stack, rule old-call/);
  assert.equal(p.cli("pack", "rule", "demo-stack/old-call", "off").code, 0);
  g = edit(); assert.equal(g.code, 0); assert.equal(g.out, ""); assert.equal(g.err, "");
  assert.equal(p.cli("pack", "rule", "demo-stack/soft-call", "block").code, 0);
  assert.equal(p.guard("src/a.py", "y = soft_call(2)\n").code, 2, "a warn rule can be raised to block here");
  const d = p.cli("pack", "rule", "demo-stack/old-call", "default");
  assert.equal(d.code, 0); assert.match(d.out, /demo-stack\/old-call: off -> block \(the pack's own\)/);
  assert.equal(edit().code, 2);
  assert.equal(readFileSync(p.installed, "utf8"), shipped, "the pack file is as shipped");
  const lines = readFileSync(p.overrides, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines, [{ rule: "demo-stack/soft-call", severity: "block" }], "one line per standing choice; default removes the line");
  // show and list say what stands
  const s = p.cli("pack", "show", "demo-stack"); assert.match(s.out, /soft-call\s+block \(here; the pack says warn\)/);
  // refusals
  const bad = p.cli("pack", "rule", "demo-stack/nope", "off"); assert.equal(bad.code, 1); assert.match(bad.all, /no rule "nope" in demo-stack/);
  const bad2 = p.cli("pack", "rule", "demo-stack/old-call", "loud"); assert.equal(bad2.code, 1); assert.match(bad2.all, /off, warn, block or default/);
  const bad3 = p.cli("pack", "rule", "ghost/old-call", "off"); assert.equal(bad3.code, 1); assert.match(bad3.all, /ghost is not installed/);
});

test("pack add --warn-only installs every rule as a warning; re-adding without it keeps the local choice until it is reset", () => {
  const p = project();
  const r = p.cli("pack", "add", p.file, "--warn-only");
  assert.equal(r.code, 0, r.all); assert.match(r.out, /warn only/);
  const g = p.guard("src/a.py", "x = old_call(1)\n");
  assert.equal(g.code, 0); assert.match(JSON.parse(g.out).hookSpecificOutput.additionalContext, /warning pack demo-stack, rule old-call/);
  assert.deepEqual(readFileSync(p.overrides, "utf8").trim().split("\n").map((l) => JSON.parse(l)), [{ rule: "demo-stack/*", severity: "warn" }]);
  const again = p.cli("pack", "add", p.file);
  assert.equal(again.code, 0); assert.match(again.out, /already installed/); assert.match(again.out, /warn only/);
  assert.equal(p.guard("src/a.py", "x = old_call(1)\n").code, 0, "an update does not fight the local choice");
  assert.equal(p.cli("pack", "rule", "demo-stack/*", "default").code, 0);
  assert.equal(p.guard("src/a.py", "x = old_call(1)\n").code, 2);
});

test("pack remove deletes the pack's file in one step, and its rules stop applying", () => {
  const p = project(); p.cli("pack", "add", p.file);
  assert.equal(p.guard("src/a.py", "x = old_call(1)\n").code, 2);
  const r = p.cli("pack", "remove", "demo-stack");
  assert.equal(r.code, 0, r.all); assert.match(r.out, /removed demo-stack/); assert.equal(existsSync(p.installed), false);
  assert.equal(p.guard("src/a.py", "x = old_call(1)\n").code, 0);
  const again = p.cli("pack", "remove", "demo-stack"); assert.equal(again.code, 1); assert.match(again.all, /demo-stack is not installed/);
});

// ---- looking before turning it on
test("pack check <path> [dir] is a dry run: hits per rule with file and line, exit 0, nothing written", () => {
  const p = project();
  mkdirSync(join(p.dir, "src", "deep"), { recursive: true }); mkdirSync(join(p.dir, "app")); mkdirSync(join(p.dir, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(p.dir, "src", "a.py"), "import os\nx = old_call(1)\n\ny = soft_call(2)\nz = old_call(3)\n");
  writeFileSync(join(p.dir, "src", "deep", "b.py"), "ok = new_call()\n");
  writeFileSync(join(p.dir, "src", "c.js"), "old_call(1)\n");
  writeFileSync(join(p.dir, "app", "page.tsx"), "const a = 1;\nlegacy_fetch();\n");
  writeFileSync(join(p.dir, "node_modules", "dep", "d.py"), "old_call(9)\n");
  const r = p.cli("pack", "check", p.file);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /old-call\s+block\s+2 hits/); assert.match(r.out, /src\/a\.py:2: x = old_call\(1\)/); assert.match(r.out, /src\/a\.py:5: z = old_call\(3\)/);
  assert.match(r.out, /soft-call\s+warn\s+1 hit\b/); assert.match(r.out, /src\/a\.py:4: y = soft_call\(2\)/);
  assert.match(r.out, /app-only\s+block\s+1 hit\b/); assert.match(r.out, /app\/page\.tsx:2: legacy_fetch\(\);/);
  assert.doesNotMatch(r.out, /c\.js|node_modules|deep\/b\.py/);
  assert.match(r.out, /3 files read, 4 hits \(3 from block rules, 1 from warn rules\)/);
  assert.match(r.out, /dry run: nothing was blocked and nothing was written/);
  assert.equal(existsSync(join(p.dir, ".memory-pulse")), false);
  // a directory argument, and JSON
  const j = JSON.parse(p.cli("pack", "check", p.file, "src", "--json").out);
  assert.equal(j.pack, "demo-stack"); assert.equal(j.files, 2);
  assert.deepEqual(j.hits.map((h) => `${h.rule} ${h.file}:${h.line}`), ["old-call a.py:2", "old-call a.py:5", "soft-call a.py:4"]);
});

test("pack check --json over a pipe is whole however many hits there are (found measuring a 954-file repository: the output stopped at 65,536 bytes)", () => {
  const p = project(); mkdirSync(join(p.dir, "src"));
  writeFileSync(join(p.dir, "src", "big.py"), Array.from({ length: 3000 }, (_, i) => `value_${i} = old_call(${i})  # a line long enough to make the report large`).join("\n") + "\n");
  const r = p.cli("pack", "check", p.file, "--json");
  assert.equal(r.code, 0, r.err); assert.ok(r.out.length > 200000, `${r.out.length} bytes`);
  const j = JSON.parse(r.out);
  assert.equal(j.hits.length, 3000); assert.equal(j.hits[2999].line, 3000); assert.equal(j.block, 3000);
  const t = p.cli("pack", "check", p.file); assert.match(t.out, /old-call\s+block\s+3000 hits/); assert.match(t.out, /\+2980 more/); assert.match(t.out, /1 file read, 3000 hits/);
});

test("pack check --installed applies this project's overrides, and --ci exits 1 only when a block rule hits", () => {
  const p = project(); p.cli("pack", "add", p.file);
  mkdirSync(join(p.dir, "src")); writeFileSync(join(p.dir, "src", "a.py"), "y = soft_call(2)\n");
  let r = p.cli("pack", "check", "--installed", "--ci"); assert.equal(r.code, 0, r.all); assert.match(r.out, /soft-call\s+warn\s+1 hit\b/);
  writeFileSync(join(p.dir, "src", "b.py"), "x = old_call(1)\n");
  r = p.cli("pack", "check", "--installed", "--ci"); assert.equal(r.code, 1); assert.match(r.out, /demo-stack\/old-call\s+block\s+1 hit\b/);
  assert.equal(p.cli("pack", "check", "--installed").code, 0, "without --ci it is a preview");
  p.cli("pack", "rule", "demo-stack/old-call", "off");
  r = p.cli("pack", "check", "--installed", "--ci"); assert.equal(r.code, 0); assert.doesNotMatch(r.out, /old-call/);
});

test("pack check --diff reads only the added lines of each changed file, with the file's own path", () => {
  const p = project(); p.cli("pack", "add", p.file);
  const git = (...a) => { const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...a], { cwd: p.dir, env: p.env, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  mkdirSync(join(p.dir, "src"));
  writeFileSync(join(p.dir, "src", "old.py"), "x = old_call(1)\n"); writeFileSync(join(p.dir, "src", "new.py"), "a = 1\n"); writeFileSync(join(p.dir, "notes.txt"), "n\n");
  git("init", "-q"); git("add", "-A"); git("commit", "-q", "-m", "base");
  writeFileSync(join(p.dir, "src", "new.py"), "a = 1\nb = old_call(2)\n"); writeFileSync(join(p.dir, "notes.txt"), "n\nold_call(3)\n");
  const r = p.cli("pack", "check", "--installed", "--diff", "--ci");
  assert.equal(r.code, 1, r.all); assert.match(r.out, /src\/new\.py:2: b = old_call\(2\)/);
  assert.doesNotMatch(r.out, /old\.py/, "a line that was already there is not what this change adds"); assert.doesNotMatch(r.out, /notes\.txt/, "out of the rule's path scope");
});

test("pack list names bundled and installed packs with rule counts and verified dates; pack show prints every rule", () => {
  const p = project();
  let l = p.cli("pack", "list"); assert.equal(l.code, 0, l.all);
  assert.match(l.out, /bundled with memory-pulse/); assert.doesNotMatch(l.out, /demo-stack/);
  p.cli("pack", "add", p.file);
  l = p.cli("pack", "list");
  assert.match(l.out, /demo-stack\s+1\.0\.0\s+demo\s+3 rules \(2 block, 1 warn\)\s+verified 2026-11-20 to 2026-11-21\s+installed/);
  const j = JSON.parse(p.cli("pack", "list", "--json").out);
  const mine = j.find((x) => x.name === "demo-stack"); assert.equal(mine.installed, true); assert.equal(mine.bundled, false); assert.equal(mine.rules, 3); assert.equal(mine.block, 2); assert.equal(mine.warn, 1);
  const s = p.cli("pack", "show", "demo-stack"); assert.equal(s.code, 0, s.all);
  assert.match(s.out, /demo-stack 1\.0\.0 \(demo\): Rules for the demo stack\./);
  for (const r of RULES) { assert.ok(s.out.includes(r.statement), r.id); assert.ok(s.out.includes(`instead: ${r.replacement}`), r.id); assert.ok(s.out.includes(r.source), r.id); assert.ok(s.out.includes(`read ${r.verified}`), r.id); assert.ok(s.out.includes(r.patterns[0]), r.id); assert.ok(s.out.includes(r.paths[0]), r.id); }
  assert.match(s.out, /old-call\s+block\b/); assert.match(s.out, /soft-call\s+warn\b/);
  const sp = p.cli("pack", "show", p.file); assert.equal(sp.code, 0); assert.match(sp.out, /demo-stack 1\.0\.0/);
});

test("pack verify <path> exits 0 on a sound pack and 1 with every finding on a broken one; pack without a verb prints usage", () => {
  const p = project();
  const ok = p.cli("pack", "verify", p.file); assert.equal(ok.code, 0, ok.all); assert.match(ok.out, /demo-stack 1\.0\.0: 3 rules, no findings/);
  const bad = tmpPack(packText([{ ...RULES[0], patterns: ["/x*/"], source: "" }, { ...RULES[1], verified: "soon" }]));
  const r = p.cli("pack", "verify", bad); assert.equal(r.code, 1);
  assert.match(r.all, /old-call: .*empty string/); assert.match(r.all, /old-call: .*source/); assert.match(r.all, /soft-call: .*verified/); assert.match(r.all, /3 findings/);
  const u = p.cli("pack"); assert.equal(u.code, 1); assert.match(u.all, /usage: memory-pulse pack list/);
  const x = p.cli("pack", "frobnicate"); assert.equal(x.code, 1); assert.match(x.all, /usage: memory-pulse pack list/);
});

test("the engine is sent rules it can judge: a glob scope is settled here, and the source and override ride in the replacement", () => {
  const p = project(); p.cli("pack", "add", p.file);
  const rules = [{ id: "mine", patterns: ["HANDRULE"], paths: ["docs/"] }, ...installedPackRules(join(p.dir, ".memory-pulse", "packs"))];
  const sent = forEngine(rules, "src/a.py");
  assert.deepEqual(sent.map((r) => r.id), ["mine", "demo-stack/old-call", "demo-stack/soft-call"], "app-only is out of scope for this path and is not sent");
  assert.deepEqual(sent[0], rules[0], "a declared invariant is sent as it is");
  assert.equal(sent[1].paths, undefined, "the engine matches prefixes only, so an in-scope glob rule is sent unscoped");
  assert.equal(sent[1].pack, undefined);
  assert.match(sent[1].statement, /^pack demo-stack, rule old-call: /);
  assert.match(sent[1].replacement, /new_call\(\)\. Source: https:\/\/example\.com\/demo\/changelog#2-0 \(read 2026-11-21\)/);
  assert.equal(sent[2].severity, "warn");
});
