// The 2026-11-21 review of the first-run commands (review/REVIEW-99824f1.md, item 3), one test per finding:
//   R-1  doctor (and init, which runs doctor) executes nothing it read from a hook file. It runs this copy's own server.mjs, or a
//        memory-pulse copy whose real path is inside the pinned data folder or a plugin cache under HOME, with node and an
//        argument list. Everything else is shown as text and reported as not run.
//   R-2  a guard hook under the wrong event, with a matcher that misses a tool the host's guard covers, or of the wrong type is a
//        FAIL, and the fix it names (install-hook) puts it right.
//   R-3  a hook that runs an older copy, or a copy of this version whose files differ, is a FAIL; init plans to put the copy back.
//   R-4  everything init writes is in the plan it prints first and in --dry-run, the team setup of a --project install included.
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fixture, snapshot, changed, line, rewrite, ROOT, VERSION, GIT } from "./_firstrun.mjs";

const json = (r) => { try { return JSON.parse(r.out); } catch { assert.fail(`not JSON (exit ${r.status}): ${r.out}\n${r.err}`); } };
const guards = (j) => j.checks.filter((c) => c.id.startsWith("guard"));
const DATA = (f) => join(f.home, ".local", "share", "memory-pulse");
const PINNED = (f, v = VERSION) => join(DATA(f), v, "server.mjs");
const FULL = "Edit|Write|MultiEdit|Bash";
const nested = (command, { event = "PreToolUse", matcher = FULL, type = "command" } = {}) => ({ hooks: { [event]: [{ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type, command }] }] } });
const write = (file, obj) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(obj, null, 2)); };
const guardOf = (file) => { const j = JSON.parse(readFileSync(file, "utf8")); return Object.entries(j.hooks).flatMap(([event, list]) => list.flatMap((e) => (e.hooks ?? [e]).filter((h) => /\bguard\b/.test(h.command ?? "")).map((h) => ({ event, matcher: e.matcher, type: h.type, command: h.command })))); };

// ---------------------------------------------------------------------------------------------------------------- R-1
// A program that leaves a file behind when it runs, and a second file a shell would leave if the command string reached one.
function hostile(f, where) {
  const dir = join(where, "tools"); mkdirSync(dir, { recursive: true });
  const ran = join(f.root, "CANARY-program-ran"), shell = join(f.root, "CANARY-shell-ran");
  writeFileSync(join(dir, "server.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(ran)}, process.argv.slice(2).join(" "));\nprocess.exit(2);\n`);
  return { path: join(dir, "server.mjs"), ran, shell, none: () => !existsSync(ran) && !existsSync(shell) };
}
// doctor as JSON; `all` adds doctor's text and every form of init (init --yes runs doctor after it installs)
const probe = (f, { all = false } = {}) => [["doctor", "--json"], ...(all ? [["doctor"], ["init", "--dry-run"], ["init"], ["init", "--yes"], ["init", "--yes", "--project"]] : [])].map((a) => f.run(a));

test("R-1 control: the canary shows a run. The hostile program leaves its file when node runs it, and a shell leaves the other", () => {
  const f = fixture(), h = hostile(f, f.proj);
  spawnSync(process.execPath, [h.path, "guard"]); assert.ok(existsSync(h.ran), "the program's canary");
  spawnSync(`true; touch ${h.shell}`, { shell: true }); assert.ok(existsSync(h.shell), "the shell's canary");
});

test("R-1: a hostile hook command in the repository's own files is never executed by doctor or init, in any shape", () => {
  const shapes = {
    "a second command after the guard call": (h) => `node "${h.path}" guard; touch ${h.shell}`,
    "a command chained with &&": (h) => `node "${h.path}" guard && touch ${h.shell}`,
    "a command substitution in the path": (h) => `node "$(touch ${h.shell})${h.path}" guard`,
    "backticks after the verb": (h) => `node "${h.path}" guard \`touch ${h.shell}\``,
    "a redirection": (h) => `node "${h.path}" guard > ${h.shell}`,
    "the plain form, a program inside the repository": (h) => `node "${h.path}" guard`,
    "the plain form without quotes": (h) => `node ${h.path} guard`,
    "a relative path": () => "node ./tools/server.mjs guard",
    "the global command with a tail": (h) => `memory-pulse guard; touch ${h.shell}`,
    "npx with a tail": (h) => `npx -y memory-pulse guard; touch ${h.shell}`,
  };
  const files = {
    ".claude/settings.json": (cmd) => nested(cmd),
    ".claude/settings.local.json": (cmd) => nested(cmd),
    ".codex/hooks.json": (cmd) => nested(cmd, { matcher: "Edit|Write|apply_patch" }),
    ".cursor/hooks.json": (cmd) => ({ version: 1, hooks: { preToolUse: [{ command: `${cmd} --host cursor`, matcher: "Write|Shell", failClosed: true }] } }),
  };
  // every shape in Claude Code's project file; three of them in each of the other files a host reads from the folder
  const everywhere = ["a second command after the guard call", "a command substitution in the path", "the plain form, a program inside the repository"];
  let n = 0;
  for (const [shape, make] of Object.entries(shapes)) for (const [file, wrap] of Object.entries(files)) {
    if (file !== ".claude/settings.json" && !everywhere.includes(shape)) continue;
    const f = fixture(), h = hostile(f, f.proj), cmd = make(h);
    write(join(f.proj, file), wrap(cmd));
    // the first one goes through doctor's text and every form of init as well
    const runs = probe(f, { all: n === 0 }); n++;
    assert.ok(h.none(), `${shape} in ${file}: ${existsSync(h.ran) ? "the repository's program was run" : "the command reached a shell"}`);
    // doctor says so: the command is shown as text and reported as not run, with the reason
    const shown = file === ".cursor/hooks.json" ? `${cmd} --host cursor` : cmd;
    const j = json(runs[0]), skipped = guards(j).filter((g) => g.status === "skipped");
    assert.ok(skipped.length >= 1 && skipped.every((g) => /^not run: \S/.test(g.detail) && g.detail.endsWith(shown) && g.command === shown), `${shape} in ${file}: ${JSON.stringify(guards(j))}`);
    if (runs[1]) { assert.match(runs[1].out, /^skipped\s+guard \(not run: /m); assert.ok(runs[1].out.includes(shown)); assert.ok(runs[4].out.includes(shown), "init --yes shows it too"); }
    // and the check does not pass on no evidence: this copy's own guard still answers
    assert.ok(guards(j).some((g) => g.status === "ok" && /this copy/.test(g.detail)), JSON.stringify(guards(j)));
  }
  assert.equal(n, 19, "ten shapes in Claude Code's file and three in each of the other three");
});

test("R-1: the user's own settings get the same treatment: a path outside the allowed folders is not run, a link is followed to where it really points", () => {
  // a program elsewhere on the machine, named in ~/.claude/settings.json
  { const f = fixture(), h = hostile(f, join(f.root, "elsewhere"));
    write(join(f.home, ".claude", "settings.json"), nested(`node "${h.path}" guard`));
    probe(f, { all: true }); assert.ok(h.none(), "a program outside the pinned folder and the plugin cache");
  }
  // inside the pinned data folder by name, outside it in fact: a link to the hostile program, with a package.json that says memory-pulse
  { const f = fixture(), h = hostile(f, join(f.root, "elsewhere")), dir = join(DATA(f), "9.9.9"); mkdirSync(dir, { recursive: true });
    symlinkSync(h.path, join(dir, "server.mjs")); writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "memory-pulse", version: "9.9.9" }));
    write(join(f.home, ".claude", "settings.json"), nested(`node "${join(dir, "server.mjs")}" guard`));
    const runs = probe(f); assert.ok(h.none(), "a file link out of the pinned folder"); assert.match(runs[0].out, /not run: /);
  }
  // the same with the whole version folder a link
  { const f = fixture(), h = hostile(f, join(f.root, "elsewhere")); mkdirSync(DATA(f), { recursive: true });
    writeFileSync(join(dirname(h.path), "package.json"), JSON.stringify({ name: "memory-pulse", version: "9.9.9" }));
    symlinkSync(dirname(h.path), join(DATA(f), "9.9.9"));
    write(join(f.home, ".claude", "settings.json"), nested(`node "${join(DATA(f), "9.9.9", "server.mjs")}" guard`));
    const runs = probe(f); assert.ok(h.none(), "a folder link out of the pinned folder"); assert.match(runs[0].out, /not run: /);
  }
  // inside the pinned data folder in fact, but not a memory-pulse copy (no package.json that says so)
  { const f = fixture(), h = hostile(f, join(DATA(f), "evil"));
    write(join(f.home, ".claude", "settings.json"), nested(`node "${h.path}" guard`));
    const runs = probe(f, { all: true }); assert.ok(h.none(), "a program in the pinned folder that is not a memory-pulse copy");
    assert.equal(runs[1].status, 1); assert.match(line(runs[1].out, "FAIL", "Claude Code") ?? "", /not a memory-pulse copy/, runs[1].out);
  }
  // a plugin record that points into the repository
  { const f = fixture(), h = hostile(f, f.proj), root = dirname(h.path); mkdirSync(join(root, "hooks"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "memory-pulse", version: VERSION }));
    write(join(root, "hooks", "hooks.json"), nested('node "${CLAUDE_PLUGIN_ROOT}/server.mjs" guard'));
    write(join(f.home, ".claude", "plugins", "installed_plugins.json"), { version: 2, plugins: { "memory-pulse@x": [{ scope: "user", installPath: root, version: VERSION }] } });
    const runs = probe(f); assert.ok(h.none(), "a plugin folder outside the plugin cache"); assert.match(runs[0].out, /not run: /);
  }
});

test("R-1: what doctor does run: the pinned copy, a link that really points at it, and a plugin copy in the cache under HOME", () => {
  const f = fixture(); mkdirSync(join(f.home, ".claude"));
  assert.equal(f.run(["install-hook"]).status, 0);
  const j = json(f.run(["doctor", "--json"]));
  assert.equal(j.ok, true, JSON.stringify(j.checks));
  assert.deepEqual(guards(j).map((g) => g.status), ["ok"]); assert.match(guards(j)[0].detail, /installed hook command/);
  // a project hook whose path is a link to the pinned copy resolves inside the pinned folder: the copy it runs is the genuine one
  mkdirSync(join(f.proj, "tools")); symlinkSync(PINNED(f), join(f.proj, "tools", "server.mjs"));
  write(join(f.proj, ".claude", "settings.json"), nested(`node "${join(f.proj, "tools", "server.mjs")}" guard`));
  const k = json(f.run(["doctor", "--json"]));
  assert.ok(guards(k).every((g) => g.status === "ok"), JSON.stringify(guards(k)));
  // a plugin in Claude Code's cache
  const g = fixture(), root = join(g.home, ".claude", "plugins", "cache", "memory-pulse", "memory-pulse", VERSION);
  mkdirSync(root, { recursive: true }); for (const p of ["server.mjs", "package.json", "lib", "hooks"]) cpSync(join(ROOT, p), join(root, p), { recursive: true });
  write(join(g.home, ".claude", "plugins", "installed_plugins.json"), { version: 2, plugins: { "memory-pulse@memory-pulse": [{ scope: "user", installPath: root, version: VERSION }] } });
  const p = json(g.run(["doctor", "--json"]));
  assert.equal(p.ok, true, JSON.stringify(p.checks)); assert.match(guards(p)[0].detail, /installed hook command/); assert.ok(guards(p)[0].command.includes(root));
});

// ---------------------------------------------------------------------------------------------------------------- R-2
test("R-2: a guard hook under the wrong event, with a matcher that misses a guarded tool, or of the wrong type is a FAIL; install-hook puts it right", () => {
  const cases = [
    ["under PostToolUse", { event: "PostToolUse" }, /PostToolUse/, /PreToolUse/],
    ["matcher Read", { matcher: "Read" }, /matcher "Read"/, /Edit, Write, MultiEdit and Bash/],
    ["the matcher releases before 0.10.0 wrote", { matcher: "Edit|Write" }, /matcher "Edit\|Write"/, /MultiEdit and Bash/],
    ["type prompt", { type: "prompt" }, /type "prompt"/, /command/],
  ];
  for (const [name, opts, ...say] of cases) {
    const f = fixture(); mkdirSync(join(f.home, ".claude")); f.run(["install-hook"]);   // the pinned copy
    const file = join(f.home, ".claude", "settings.json");
    write(file, nested(`node "${PINNED(f)}" guard`, opts));
    const r = f.run(["doctor"]);
    assert.equal(r.status, 1, `${name}: ${r.out}`);
    const l = line(r.out, "FAIL", "Claude Code"); assert.ok(l, `${name}: ${r.out}`);
    for (const re of say) assert.match(l, re, name);
    assert.match(l, /Fix: memory-pulse install-hook$/, name);
    // the fix it names works
    assert.equal(f.run(["install-hook"]).status, 0);
    const after = f.run(["doctor"]); assert.equal(after.status, 0, `${name}, after the fix: ${after.out}`);
    assert.ok(guardOf(file).some((g) => g.event === "PreToolUse" && g.type === "command" && g.matcher === FULL), `${name}: ${JSON.stringify(guardOf(file))}`);
  }
  // a matcher that covers the four tools some other way is not a failure, and install-hook leaves it as it is
  for (const matcher of [undefined, "*", "Edit|Write|MultiEdit|Bash|NotebookEdit", "(Multi)?Edit|Write|Bash"]) {
    const f = fixture(); mkdirSync(join(f.home, ".claude")); f.run(["install-hook"]);
    const file = join(f.home, ".claude", "settings.json"), s = JSON.parse(readFileSync(file, "utf8"));
    if (matcher === undefined) delete s.hooks.PreToolUse[0].matcher; else s.hooks.PreToolUse[0].matcher = matcher;
    write(file, s); const before = readFileSync(file, "utf8");
    assert.equal(f.run(["doctor"]).status, 0, `matcher ${JSON.stringify(matcher)}`);
    f.run(["install-hook"]); assert.equal(readFileSync(file, "utf8"), before, `install-hook leaves matcher ${JSON.stringify(matcher)} alone`);
  }
});

test("R-2: Codex and Cursor are held to their own event and matcher", () => {
  const f = fixture(); mkdirSync(join(f.home, ".codex")); mkdirSync(join(f.home, ".cursor")); mkdirSync(join(f.home, ".claude"));
  f.run(["install-hook"]); f.run(["install-hook", "--codex"]); f.run(["install-hook", "--cursor"]);
  assert.equal(f.run(["doctor"]).status, 0);
  const codex = join(f.home, ".codex", "hooks.json"), cursor = join(f.home, ".cursor", "hooks.json");
  const c = JSON.parse(readFileSync(codex, "utf8")); c.hooks.PreToolUse[0].matcher = "Edit|Write"; write(codex, c);
  const u = JSON.parse(readFileSync(cursor, "utf8")); u.hooks.postToolUse.push(u.hooks.preToolUse.pop()); write(cursor, u);
  const r = f.run(["doctor"]);
  assert.equal(r.status, 1, r.out);
  const lc = line(r.out, "FAIL", "Codex"); assert.match(lc ?? "", /apply_patch/, r.out); assert.match(lc, /Fix: memory-pulse install-hook --codex$/);
  const lu = line(r.out, "FAIL", "Cursor"); assert.match(lu ?? "", /postToolUse/, r.out); assert.match(lu, /preToolUse/); assert.match(lu, /Fix: memory-pulse install-hook --cursor$/);
  f.run(["install-hook", "--codex"]); f.run(["install-hook", "--cursor"]);
  assert.equal(f.run(["doctor"]).status, 0, "both fixes work");
  // Cursor's matcher lives on the flat entry
  const v = JSON.parse(readFileSync(cursor, "utf8")); v.hooks.preToolUse.find((h) => /guard/.test(h.command)).matcher = "Write"; write(cursor, v);
  const s = f.run(["doctor"]); assert.equal(s.status, 1); assert.match(line(s.out, "FAIL", "Cursor") ?? "", /Shell/, s.out);
  f.run(["install-hook", "--cursor"]); assert.equal(f.run(["doctor"]).status, 0);
});

test("R-2: install-hook brings an old guard matcher up to date without touching a neighbour's hook, and init does it on an upgrade", () => {
  // the entry is shared with someone else's hook: theirs keeps its matcher, ours moves to an entry of its own
  const f = fixture(); mkdirSync(join(f.home, ".claude"));
  const file = join(f.home, ".claude", "settings.json");
  write(file, { hooks: { PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "echo theirs" }, { type: "command", command: "npx -y memory-pulse guard" }] }] } });
  assert.equal(f.run(["install-hook"]).status, 0);
  const pre = JSON.parse(readFileSync(file, "utf8")).hooks.PreToolUse;
  assert.deepEqual(pre.find((e) => e.hooks.some((h) => h.command === "echo theirs")), { matcher: "Edit|Write", hooks: [{ type: "command", command: "echo theirs" }] });
  assert.deepEqual(guardOf(file), [{ event: "PreToolUse", matcher: FULL, type: "command", command: `node "${PINNED(f)}" guard` }]);
  // the review's case: hooks from before 0.10.0, then init
  const g = fixture(); const old = join(g.home, ".claude", "settings.json");
  write(old, { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "npx -y memory-pulse brief" }] }], PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "npx -y memory-pulse guard" }] }] } });
  assert.equal(g.run(["doctor"]).status, 1, "before: MultiEdit and Bash never reach the guard");
  const r = g.run(["init", "--yes"]); assert.equal(r.status, 0, r.out);
  assert.deepEqual(guardOf(old), [{ event: "PreToolUse", matcher: FULL, type: "command", command: `node "${PINNED(g)}" guard` }]);
});

// ---------------------------------------------------------------------------------------------------------------- R-3
test("R-3: a hook that runs a copy of this version whose files differ is a FAIL; init plans to put the copy back and does", () => {
  const f = fixture(); mkdirSync(join(f.home, ".claude")); f.run(["install-hook"]);
  assert.equal(f.run(["doctor"]).status, 0);
  rewrite(PINNED(f), `${readFileSync(PINNED(f), "utf8")}\n// what an upgrade that kept the version number leaves behind\n`);
  const r = f.run(["doctor"]);
  assert.equal(r.status, 1, r.out);
  const l = line(r.out, "FAIL", "Claude Code"); assert.ok(l, r.out);
  assert.match(l, /differ/); assert.ok(l.includes(dirname(PINNED(f))), l); assert.match(l, /Fix: memory-pulse install-hook$/);
  const before = snapshot(f.root);
  const dry = f.run(["init", "--dry-run"]);
  assert.match(dry.out, /^  copy\s+\S*memory-pulse\/\d+\.\d+\.\d+\s/m, dry.out); assert.doesNotMatch(dry.out, /Nothing to change/);
  assert.deepEqual(changed(before, snapshot(f.root)), []);
  const i = f.run(["init", "--yes"]); assert.equal(i.status, 0, i.out);
  assert.equal(readFileSync(PINNED(f), "utf8"), readFileSync(join(ROOT, "server.mjs"), "utf8"), "the pinned copy is this package again");
  assert.ok(line(i.out, "ok", "Claude Code"), i.out);
});

test("R-3: a hook that runs an older version is a FAIL that names both versions; a newer one is not; install-hook re-pins", () => {
  const f = fixture(); mkdirSync(join(f.home, ".claude")); f.run(["install-hook"]);
  const file = join(f.home, ".claude", "settings.json");
  const repin = (v) => { const dir = join(DATA(f), v); cpSync(dirname(PINNED(f)), dir, { recursive: true });
    rewrite(join(dir, "package.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, "package.json"), "utf8")), version: v }));
    writeFileSync(file, readFileSync(file, "utf8").split(`/${VERSION}/server.mjs`).join(`/${v}/server.mjs`)); };
  repin("0.1.0");
  const r = f.run(["doctor"]);
  assert.equal(r.status, 1, r.out);
  const l = line(r.out, "FAIL", "Claude Code"); assert.ok(l, r.out);
  assert.match(l, /0\.1\.0/); assert.ok(l.includes(VERSION), l); assert.match(l, /older/); assert.match(l, /Fix: memory-pulse install-hook$/);
  assert.equal(f.run(["install-hook"]).status, 0);
  assert.equal(f.run(["doctor"]).status, 0, "after the fix every hook runs this version");
  assert.ok(guardOf(file)[0].command.includes(`/${VERSION}/server.mjs`));
  // a copy newer than this one is not a failure of the hooks
  repin("999.0.0");
  const n = f.run(["doctor"]); assert.equal(n.status, 0, n.out); assert.match(line(n.out, "ok", "Claude Code") ?? "", /999\.0\.0/);
  // a project hook pinned to an older release through npx
  const g = fixture();
  write(join(g.proj, ".claude", "settings.json"), nested("npx -y memory-pulse@0.1.0 guard"));
  const p = g.run(["doctor"]); assert.equal(p.status, 1, p.out);
  const lp = line(p.out, "FAIL", "Claude Code"); assert.match(lp ?? "", /0\.1\.0/, p.out); assert.match(lp, /Fix: memory-pulse install-hook --project$/);
  write(join(g.proj, ".claude", "settings.json"), nested("npx -y memory-pulse guard"));
  assert.equal(g.run(["doctor"]).status, 0);
});

// ---------------------------------------------------------------------------------------------------------------- R-4
// The plan's lines that say a file or folder will be written, as paths relative to the fixture.
function planned(f, out) {
  const block = out.slice(out.indexOf("\nPlan\n") + 6); const lines = block.slice(0, block.indexOf("\n\n")).split("\n");
  const rel = (p) => { for (const base of [realpathSync(f.root), f.root]) if (p === base || p.startsWith(`${base}/`)) return p.slice(base.length + 1); return p; };
  return lines.map((l) => /^  (write|create|copy)\s+(.+?)   /.exec(l)).filter(Boolean).map((m) => ({ verb: m[1], path: rel(m[2].replace(/\/$/, "")) }));
}
const under = (file, path) => file === path || file.startsWith(`${path}/`);

for (const [name, opts] of Object.entries({
  "one host, user scope": { hosts: [".claude"], args: [] },
  "three hosts, user scope": { hosts: [".claude", ".codex", ".cursor"], args: [] },
  "--project outside a git work tree": { hosts: [".claude"], args: ["--project"] },
  "--project in a git work tree": { hosts: [".claude", ".cursor"], args: ["--project"], git: true },
  "--project in a git work tree, in a folder below the top": { hosts: [".claude"], args: ["--project"], git: true, sub: "packages/app" },
})) {
  test(`R-4: everything init writes is in the plan it prints first, and in --dry-run (${name})`, { skip: opts.git && !GIT ? "no git on this machine" : false }, () => {
    const f = fixture({ git: !!opts.git }); for (const h of opts.hosts) mkdirSync(join(f.home, h));
    const cwd = opts.sub ? join(f.proj, opts.sub) : f.proj; mkdirSync(cwd, { recursive: true });
    const before = snapshot(f.root);
    const dry = f.run(["init", "--dry-run", ...opts.args], { cwd });
    assert.equal(dry.status, 0, dry.out + dry.err);
    assert.deepEqual(changed(before, snapshot(f.root)), [], "the dry run writes nothing");
    const r = f.run(["init", "--yes", ...opts.args], { cwd });
    assert.equal(r.status, 0, r.out + r.err);
    const plan = planned(f, r.out);
    assert.deepEqual(plan, planned(f, dry.out), "the plan of the real run is the plan of the dry run");
    assert.ok(plan.length >= 2, r.out);
    const files = changed(before, snapshot(f.root));
    // every file that changed is under a path the plan named
    for (const file of files) assert.ok(plan.some((p) => under(file, p.path)), `${file} was written and is not in the plan:\n${r.out.slice(0, r.out.indexOf("memory-pulse doctor"))}`);
    // every path the plan named was written (a folder it creates may be empty)
    for (const p of plan) assert.ok(p.verb === "create" ? existsSync(join(f.root, p.path)) : files.some((file) => under(file, p.path)), `the plan names ${p.path} and nothing was written there`);
    if (opts.git) {
      const base = `proj${opts.sub ? `/${opts.sub}` : ""}`;
      assert.ok(plan.some((p) => p.path === `${base}/.gitattributes`) && plan.some((p) => p.path === "proj/.git/config"), JSON.stringify(plan));
      assert.ok(files.includes("proj/.git/config") && files.includes(`${base}/.gitattributes`), JSON.stringify(files));
      // and what was done to git's configuration is said, not only planned
      assert.match(r.out.slice(r.out.indexOf("\n\n", r.out.indexOf("\nPlan\n"))), /merge\.memory-pulse\.driver/);
    }
    // a second run has nothing in its plan and writes nothing
    const mid = snapshot(f.root);
    const again = f.run(["init", "--yes", ...opts.args], { cwd });
    assert.equal(again.status, 0, again.out); assert.deepEqual(planned(f, again.out), [], again.out); assert.match(again.out, /Nothing to change/);
    assert.deepEqual(changed(mid, snapshot(f.root)), []);
  });
}

// ---------------------------------------------------------------------------------------------------------------- R-5
test("R-5: doctor's synthetic edits are of three kinds, so a copy that reads only a file write is caught", () => {
  const f = fixture(); mkdirSync(join(f.home, ".claude")); f.run(["install-hook"]);
  // a stand-in for the pinned copy that blocks a Write of the withdrawn value and lets an Edit and a shell write through
  const only = (tools) => rewrite(PINNED(f), `let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => { const p = JSON.parse(s), t = JSON.stringify(p.tool_input);
    if (${JSON.stringify(tools)}.includes(p.tool_name) && t.includes("doctor-withdrawn-7f3a")) { process.stderr.write("doctor-withdrawn-7f3a was withdrawn"); process.exit(2); } process.exit(0); });\n`);
  only(["Write"]);
  assert.match(line(f.run(["doctor"]).out, "FAIL", "guard") ?? "", /did not block an edit to the withdrawn value/);
  only(["Write", "Edit"]);
  assert.match(line(f.run(["doctor"]).out, "FAIL", "guard") ?? "", /did not block a shell write of the withdrawn value/);
  only(["Write", "Edit", "Bash"]);
  assert.ok(line(f.run(["doctor"]).out, "ok", "guard"), "a copy that blocks all three and passes the other two answers as a guard does");
});

test("R-5: Ctrl-C leaves no temporary folder behind: demo, doctor and init remove theirs and exit 130", { skip: process.platform === "win32" ? "process groups" : false }, async () => {
  const { spawn } = await import("node:child_process");
  const { readdirSync, rmSync } = await import("node:fs");
  for (const [args, slow] of [[["demo"], "guard"], [["doctor", "--offline"], "guard"], [["init", "--dry-run"], "install-hook"]]) {
    const f = fixture(); mkdirSync(join(f.home, ".claude"));
    writeFileSync(join(f.home, ".claude", "settings.json"), JSON.stringify({ env: { SECRET: "kept-out-of-tmp" }, hooks: {} }));
    // every child of the command that runs `slow` says it has started and then waits, so the signal lands while a temporary folder exists
    const started = join(f.root, "child-started"), pre = join(f.root, "slow.cjs");
    writeFileSync(pre, `if (process.argv[2] === ${JSON.stringify(slow)}) { require("node:fs").writeFileSync(${JSON.stringify(started)}, "x"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000); }\n`);
    const { SERVER } = await import("./_firstrun.mjs");
    const child = spawn(process.execPath, [SERVER, ...args], { cwd: f.proj, env: { ...f.env, NODE_OPTIONS: `--require ${pre}` }, detached: true, stdio: "ignore" });
    const done = new Promise((r) => child.on("exit", (code, signal) => r({ code, signal })));
    for (let i = 0; i < 1500 && !existsSync(started); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(existsSync(started), `${args.join(" ")}: the slow child started`);
    assert.ok(readdirSync(f.tmp).some((d) => d.startsWith("memory-pulse-")), `${args.join(" ")}: a temporary folder exists when the signal is sent`);
    process.kill(-child.pid, "SIGINT");   // what a terminal does on Ctrl-C: the whole foreground group
    const end = await done;
    assert.deepEqual(readdirSync(f.tmp), [], `${args.join(" ")}: nothing is left in TMPDIR`);
    assert.equal(end.code, 130, `${args.join(" ")}: exit ${end.code} ${end.signal}`);
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("R-5: a sentence where a stack would print: a TMPDIR that cannot be written, a settings file that cannot be written", { skip: process.getuid?.() === 0 ? "root writes anywhere" : false }, async () => {
  const { chmodSync } = await import("node:fs");
  const f = fixture(); chmodSync(f.tmp, 0o500);
  try {
    for (const args of [["demo"], ["doctor", "--offline"], ["init", "--dry-run"]]) {
      mkdirSync(join(f.home, ".claude"), { recursive: true });
      const r = f.run(args);
      assert.equal(r.status, 1, `${args.join(" ")}: ${r.out}${r.err}`);
      assert.match(r.err, new RegExp(`^memory-pulse ${args[0]}: cannot make a temporary folder in [^\\n]+\\n$`), r.err);
      assert.doesNotMatch(r.out + r.err, /\n\s+at |node:fs|node:internal/, "no stack");
    }
  } finally { chmodSync(f.tmp, 0o700); }
  const g = fixture(); mkdirSync(join(g.home, ".claude")); const file = join(g.home, ".claude", "settings.json");
  writeFileSync(file, "{}"); chmodSync(file, 0o400);
  try {
    const r = g.run(["init", "--yes"]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /^could not install the Claude Code hooks: EACCES[^\n]*settings\.json/m, r.out);
    assert.doesNotMatch(r.out + r.err, /\n\s+at |node:fs:\d|node:internal/, "no stack");
    assert.equal(readFileSync(file, "utf8"), "{}");
  } finally { chmodSync(file, 0o600); }
});

test("R-5: init's closing lines say an agent's edit is blocked only when a host is set up", () => {
  const none = fixture().run(["init", "--yes"]);
  assert.equal(none.status, 0, none.out);
  assert.doesNotMatch(none.out, /is blocked the same way/); assert.match(none.out, /No editor is set up yet/);
  const f = fixture(); mkdirSync(join(f.home, ".claude"));
  const one = f.run(["init", "--yes"]);
  assert.match(one.out, /an agent's edit that writes \$49 in this folder is blocked the same way/); assert.doesNotMatch(one.out, /No editor is set up yet/);
});

test("R-5: install-hook does not report hooks it did not write: a hooks value that is a list", () => {
  const f = fixture(); const file = join(f.home, ".claude", "settings.json");
  write(file, { hooks: [] });
  const r = f.run(["install-hook"]);
  assert.equal(r.status, 0, r.err); assert.match(r.out, /installed 8 hook\(s\)/);
  assert.equal(guardOf(file).length, 1, "the eight hooks it reports are in the file");
  assert.equal(f.run(["doctor"]).status, 0);
  // a list with entries is not a shape either host reads; it is left as it is and said
  write(file, { hooks: [{ matcher: "Edit", hooks: [] }] }); const before = readFileSync(file, "utf8");
  const s = f.run(["install-hook"]);
  assert.equal(s.status, 1); assert.match(s.err, /refusing to touch [^\n]*settings\.json: its "hooks" value is a list/); assert.equal(readFileSync(file, "utf8"), before);
  write(join(f.home, ".cursor", "hooks.json"), { version: 1, hooks: [] });
  assert.equal(f.run(["install-hook", "--cursor"]).status, 0); assert.equal(guardOf(join(f.home, ".cursor", "hooks.json")).length, 1);
});

test("R-1 follow-on: a guard hook that names the global command is not run; it is a FAIL when no memory-pulse command is on PATH", () => {
  // doctor used to learn this by running the command through a shell (exit 127). It no longer runs it, so it looks instead.
  const f = fixture(); write(join(f.home, ".claude", "settings.json"), nested("memory-pulse guard"));
  const r = f.run(["doctor"]);
  assert.equal(r.status, 1, r.out);
  const l = line(r.out, "FAIL", "Claude Code"); assert.match(l ?? "", /runs the memory-pulse command, which is not on PATH/, r.out);
  assert.match(l, /Fix: take that hook out of [^\n]*settings\.json by hand[^\n]*memory-pulse install-hook$/);
  // with a memory-pulse command on PATH the hook stands, and the command is still not run: doctor cannot say which program that is
  const ran = join(f.root, "CANARY-global-ran");
  writeFileSync(join(f.bin, "memory-pulse"), `#!/bin/sh\ntouch ${ran}\nexit 2\n`, { mode: 0o755 });
  const s = f.run(["doctor"]);
  assert.equal(s.status, 0, s.out); assert.ok(!existsSync(ran), "the command on PATH was not run");
  assert.match(s.out, /^skipped\s+guard \(not run: it runs whichever memory-pulse command is first on PATH: memory-pulse guard\)$/m);
});
