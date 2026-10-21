// Automatic capture (2026-10-21, phase 1): memory-pulse records what the agent did with no model calls and no network, then turns it
// into findings that point at their evidence. Tests: test/capture.test.js.
//
//   capture      PostToolUse / PostToolUseFailure hook (installed async: a tool call never waits for it). One compact observation per
//                tool call into the session's episode, .memory-pulse/episodes/<session>.jsonl, chained like every ledger: an edit
//                (path, lines added and removed), a command (secrets scrubbed, a leading `cd ... &&` dropped, ok or failed with its exit
//                code and first error line), a read (path), any other tool (its name). Tool output is never stored, only its outcome;
//                error text that reads like an instruction is withheld.
//   consolidate  Stop / PreCompact hook, and SessionEnd with --final. A command that failed and later passed becomes a fix finding
//                (what failed, the files edited in between); a command whose last run failed becomes an open thread, retired by the
//                fix that follows it. --final adds a session summary and exports the episode as a .rain capsule. Every finding
//                carries evidence {episode, rows, head} (named apart from `origin`, which .rain merges use): the episode rows it rests on and the chain head after them, so anyone holding
//                the capsule can check the evidence without a key. Each finding is written once (capture_key).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, relative, isAbsolute } from "node:path";

// The marker is "[secret]", not "<secret>": an angle-bracket tag reads as a boundary marker to the instruction screen, which withheld
// every scrubbed error line (review 2026-10-21). Key formats added after the review found them stored verbatim: Stripe test / restricted /
// publishable / webhook keys, Hugging Face, Docker PATs, Cloudflare user tokens, Anthropic, xAI, PyPI, Shopify, SendGrid, Google OAuth.
// Narrowed after the re-review found ordinary text eaten: hf_ needs a token's shape (hf_hub_download is a function), a credential header
// only after -H / --header or at the start of a line (a TypeScript type mentions `authorization: string`), -u user:pass only for HTTP
// clients (docker run -u 1000:1000 is a uid).
// A value looks like a credential when it has a digit and six characters, or sixteen characters: "password: rejects passwords shorter
// than 8" is a test name, "client_secret: abc123def456ghi" is not (final pass 2026-10-21).
const credentialish = (v) => { const x = String(v).replace(/^["']|["']$/g, ""); return (/\d/.test(x) && x.length >= 6) || x.length >= 16; };
const SECRET = [
  [/\b(?:mp_live_|sk-ant-|sk-|sk_live_|sk_test_|rk_live_|rk_test_|pk_live_|pk_test_|whsec_|ghp_|gho_|ghs_|ghu_|github_pat_|xox[abposr]-|AKIA|ASIA|AIza|glpat-|npm_|dckr_pat_|cfut_|xai-|pypi-|shpat_|ya29\.)[A-Za-z0-9_\-]{8,}/g, "[secret]"],
  [/\bhf_[A-Za-z0-9]{30,}\b/g, "[secret]"],
  [/\bSG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}/g, "[secret]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[secret]"],                                      // a JWT
  [/(\b(?:discord(?:app)?\.com\/api\/webhooks\/\d+|hooks\.slack\.com\/services(?:\/[A-Z0-9]+){2})\/)[A-Za-z0-9_-]+/g, "$1[secret]"],
  // a header that carries a credential, after -H / --header or at the start of a line; the scheme (Bearer, Basic, Token) is kept
  [/((?:^|\n|(?:-H|--header)[= ]?\s*["']?)\s*(?:x-)?[A-Za-z-]*(?:api[-_]?key|token|authorization|cookie|session[-_]?id)\s*:\s*)(?:(Bearer|Basic|Token|Digest)\s+)?("[^"\n]{6,}"|'[^'\n]{6,}'|[^\s"',;]{6,})/gi,
    (m, pre, scheme, v) => (scheme || credentialish(v) ? `${pre}${scheme ? `${scheme} ` : ""}[secret]` : m)],
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=\-]{8,}/gi, "$1 [secret]"],
  // a key whose name says it is secret, in JSON ("password":"...", not empty) or YAML (client_secret: ...); a type name is not a value
  [/("[\w-]*(?:password|passwd|secret|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|auth[-_]?token|private[-_]?key|token)"\s*:\s*)"[^"]+"/gi, '$1"[secret]"'],
  [/\b([\w-]*(?:password|passwd|client[-_]?secret|secret[-_]?key|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|auth[-_]?token|private[-_]?key)\s*:\s*)(?!(?:string|number|boolean|any|unknown|undefined|null|object|true|false)\b)("[^"\n]{4,}"|'[^'\n]{4,}'|[^\s"',;]{4,})/gi,
    (m, pre, v) => (credentialish(v) ? `${pre}[secret]` : m)],
  // NAME=value where a part of NAME (split on _) is KEY, TOKEN, SECRET, PASS...: DB_PASSWORD=..., MEMORY_PULSE_KEY=...; not passed=3
  [/\b((?:[A-Za-z0-9]+_)*(?:API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?)(?:_[A-Za-z0-9]+)*\s*=\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1[secret]"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, "$1[secret]@"],
  [/(\b(?:curl|wget|http|https|httpie|xh)\b[^|;&\n]*?\s(?:-u|--user)[= ]?\s*[^\s:'"]+:)(\S+)/g, "$1[secret]"],      // curl -u user:pass
  [/(\b(?:mysql|mysqldump|mariadb|mysqladmin)\b[^|;&\n]*?\s-p)(?!\s)(\S+)/g, "$1[secret]"],                         // mysql -pPASSWORD
  [/(\b(?:docker|podman|helm|nerdctl)\s+(?:registry\s+)?login\b[^|;&\n]*?\s(?:-p|--password)[= ]?\s*)(\S+)/g, "$1[secret]"],
  [/(\bredis-cli\b[^|;&\n]*?\s-a\s+)(\S+)/g, "$1[secret]"],
  [/(\bopenssl\b[^|;&\n]*?\s(?:-k|-kfile|-pass|-passin|-passout)\s+)(\S+)/g, "$1[secret]"],
  [/(\b(?:zip|unzip)\b[^|;&\n]*?\s-P\s*)(\S+)/g, "$1[secret]"],
  [/(\b7za?\b[^|;&\n]*?\s-p)(\S+)/g, "$1[secret]"],
  [/(\bsshpass\s+-p\s*)(\S+)/g, "$1[secret]"],
  [/(--?(?:password|token|secret|api-key|apikey|key|jwt)[= ]+)\S+/gi, "$1[secret]"],
  // a long opaque token: 40+ characters with a digit and both cases, and no slash, so a file path is never one
  [/(?<![A-Za-z0-9+/])[A-Za-z0-9+]{40,}={0,2}(?![A-Za-z0-9+/])/g, (m) => (/\d/.test(m) && /[a-z]/.test(m) && /[A-Z]/.test(m) ? "[secret]" : m)],
];
export const scrub = (s) => SECRET.reduce((t, [re, to]) => t.replace(re, to), String(s ?? ""));
const one = (s, n = 160) => { const v = String(s ?? "").replace(/\s+/g, " ").trim(); return v.length > n ? v.slice(0, n - 1) + "…" : v; };
// Text written by tools is data. Withheld when the instruction screen flags it, or when it addresses the agent ("NOTE TO THE AGENT: ...",
// which passed the screen; review 2026-10-21). Not on a destructive command or the name of a test: "rm -rf dist", husky's "add --no-verify
// to bypass" and "✖ agent: should retry on 429" are ordinary output (re-review 2026-10-21).
const ADDRESSED = /\b(?:note|instructions?|attention)\s+(?:to|for)\s+(?:the\s+)?(?:agent|assistant|ai|model|llm|claude|codex|cursor)\s*[:,-]|\b(?:dear|hey|hi)\s+(?:agent|assistant|claude)\b|\b(?:agent|assistant|ai|llm|claude)s?\s*[,:]\s*you\s+(?:must|should|need to|have to|are)\b/i;
const unsafe = (v, instructionLike) => !!v && (instructionLike(v).length > 0 || ADDRESSED.test(v));
const showRaw = (p, cwd) => { if (!p) return ""; const a = isAbsolute(p) ? p : join(cwd, p); return a.startsWith(cwd + "/") ? relative(cwd, a) : a.startsWith(homedir()) ? "~" + a.slice(homedir().length) : a; };
const show = (p, cwd, instructionLike = () => []) => { const v = scrub(showRaw(p, cwd)); return unsafe(v, instructionLike) ? "(path withheld: it reads like an instruction)" : v; };
export const commandKey = (cmd) => one(scrub(String(cmd ?? "").replace(/^\s*(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*)+/, "")), 200);
const EDIT = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "apply_patch"]);

// Only checks make fixes and open threads. Replaying 3,541 real tool calls (four Claude Code sessions, 2026-10-21) gave 1 fix and 43
// "open threads", nearly all noise: one-off pipelines and heredoc scripts never repeat, and permission refusals read as failures. A
// check is a test / build / lint / typecheck command, keyed by its family and the files it names, so `python3 -m pytest -q x.py 2>&1 |
// tail -1` and `pytest x.py -x` are one check. The family must start a segment of the command (after env assignments and runners).
const RUNNER = String.raw`^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:(?:npx|bunx|pnpx|uv\s+run|poetry\s+run|pipenv\s+run|time|env(?:\s+-u\s+\S+)*)\s+)*(?:[\w.~/-]*/)?`;
const FAMILIES = [
  [String.raw`(npm|pnpm|yarn|bun)\s+(?:run\s+)?(test|build|lint|typecheck|type-check|check|ci)\b`, (m) => `${m[1]} ${m[2]}`],
  [String.raw`node\s+--test\b`, () => "node --test"],
  [String.raw`(?:python3?\s+-m\s+)?pytest\b`, () => "pytest"],
  [String.raw`cargo\s+(test|build|check|clippy)\b`, (m) => `cargo ${m[1]}`],
  [String.raw`go\s+(test|build|vet)\b`, (m) => `go ${m[1]}`],
  [String.raw`make(?:\s+([a-z][\w-]*))?\s*$`, (m) => `make${m[1] ? " " + m[1] : ""}`],
  [String.raw`(tsc|eslint|ruff|mypy|jest|vitest|flake8|pylint|rubocop|phpunit|deno\s+test|swift\s+test|dotnet\s+test)\b`, (m) => m[1].toLowerCase().replace(/\s+/g, " ")],
  [String.raw`(gradlew?|mvn)\s+(test|build|check|verify|package)\b`, (m) => `${m[1]} ${m[2]}`],
].map(([re, name]) => [new RegExp(RUNNER + re, "i"), name]);
const FILEARG = /(?:^|\s)((?:[\w.-]+\/)*[\w.-]+\.(?:py|js|mjs|cjs|ts|tsx|jsx|rs|go|rb|java|kt|cs|php|swift))(?=\s|$)/g;
export function checkKey(cmd) {
  const c = String(cmd ?? "").replace(/^\s*(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*)+/, "");
  if (/<<-?\s*['"]?\w+/.test(c)) return null;                                    // a heredoc script is a one-off
  for (const seg of c.split(/\s*(?:&&|\|\||;|\||\n)\s*/)) {
    const bare = seg.replace(/\s*\d?>&?\s*\S+/g, "");                             // redirections are not part of the check
    for (const [re, name] of FAMILIES) {
      const m = re.exec(bare); if (!m) continue;
      const files = [...new Set([...bare.slice(m.index + m[0].length).matchAll(FILEARG)].map((x) => x[1]))].sort();
      return [name(m), ...files].join(" ");
    }
  }
  return null;
}
// A check's outcome from its own summary line. Agents pipe checks through grep or tail, so the shell's exit code is the last command's
// (replay of real sessions, 2026-10-21: 0 fixes in 6,362 tool calls on exit codes alone). Read at capture time; the output itself is
// never stored, only the summary line that decided it. null when no runner summary is recognised (the exit code then decides).
const FAIL_SUMMARY = [
  /^ℹ fail ([1-9]\d*)$/m, /\b([1-9]\d*) (?:failed|failing|failures?)\b/i, /^Tests?:\s+.*\b([1-9]\d*) failed/im, /test result: FAILED/,
  /^FAIL\b/m, /\berror TS\d+/, /\b([1-9]\d*) problems? \(/, /^Found ([1-9]\d*) errors?/m, /\b([1-9]\d*) errors? (?:in|found)\b/i,
];
const PASS_SUMMARY = [/^ℹ fail 0$/m, /\b\d+ passed\b(?![^\n]*\bfailed)/i, /^Tests?:\s+\d+ passed/im, /test result: ok\b/, /^ok\s+\S+/m, /^Success: no issues/m, /^All checks passed/m];
// The specific error a failed check printed, most specific first: an exception line, pytest's FAILED line, node's ✖ test, a TypeScript
// error, a jest / vitest marker, a Rust panic. A count line ("ℹ fail 2") carries no signature (measured 2026-10-21: 0 of 71 failures
// re-matched an earlier fix by it), so it is kept as the summary and used only when nothing more specific was printed.
const SPECIFIC = [
  /^\s*(?:E\s+)?((?:[A-Z]\w*(?:Error|Exception)|AssertionError)\b.*)$/m, /^FAILED\s+(\S+(?:\s+-\s+.*)?)$/m, /^\s*✖\s+(.+)$/m,
  /(error TS\d+:.*)$/m, /^\s*(?:●|×|✗)\s+(.+)$/m, /(thread '[^']*' panicked at .*)$/m,
];
const lineAt = (text, i) => text.slice(text.lastIndexOf("\n", i) + 1, (text.indexOf("\n", i) + 1 || text.length + 1) - 1).trim();
export function checkOutcome(stdout, stderr) {
  const text = `${stdout ?? ""}\n${stderr ?? ""}`;
  for (const re of FAIL_SUMMARY) {
    const m = re.exec(text); if (!m) continue;
    const summary = lineAt(text, m.index);
    let specific = null; for (const sp of SPECIFIC) { const x = sp.exec(text); if (x) { specific = (x[1] ?? x[0]).trim(); break; } }
    return { ok: false, line: specific ?? summary, summary };
  }
  for (const re of PASS_SUMMARY) if (re.test(text)) return { ok: true };
  return null;
}

// a refusal to run (a permission prompt, the auto-mode classifier, a hook block) is not a failure of the command
const DENIED = /auto mode classifier|permission (?:for this action )?(?:was )?denied|<tool_use_error>|\bblocked:|user (?:rejected|denied|doesn't want)|requires? (?:approval|permission)|not (?:permitted|allowed) to run/i;

export const episodeDir = (ledger) => join(dirname(ledger), "episodes");
export const episodePath = (ledger, session) => join(episodeDir(ledger), `${String(session ?? "session").replace(/[^\w.-]/g, "_").slice(0, 80)}.jsonl`);

function lineCounts(resp, input) {
  const patch = Array.isArray(resp?.structuredPatch) ? resp.structuredPatch : [];
  let added = 0, removed = 0;
  for (const h of patch) for (const l of h.lines ?? []) { if (l.startsWith("+")) added++; else if (l.startsWith("-")) removed++; }
  if (!patch.length && typeof input?.content === "string") added = input.content.split("\n").length;
  return { added, removed };
}

// A command's first error line. Only a check (whose output is its diagnostics) falls back to the first line when no line names an error;
// any other failed command keeps only a line that does, so the first line of its output (a token printed by `cat`, a hash) is never
// stored as its error (re-review 2026-10-21).
function firstError(text, instructionLike, { fallback = false } = {}) {
  const lines = String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean).filter((l) => !/^Exit code \d+$/i.test(l));
  const pick = lines.find((l) => /✖|✗|\berror\b|\bfail(?:ed|ure)?\b|traceback|exception|assert|panic|cannot|can't|not found|no such file|denied|permission|invalid|unknown|unexpected|refused|timed out|fatal|missing|unable/i.test(l)) ?? (fallback ? lines[0] : "") ?? "";
  const v = one(scrub(pick));
  return unsafe(v, instructionLike) ? "(error text withheld: it reads like an instruction)" : v;
}

/** The observation one hook call carries, or null. Pure: no IO. */
export function observe(hook, { instructionLike }) {
  const ev = hook?.hook_event_name, name = hook?.tool_name, input = hook?.tool_input ?? {}, cwd = hook?.cwd || process.cwd();
  if ((ev !== "PostToolUse" && ev !== "PostToolUseFailure") || typeof name !== "string") return null;
  // an exit code in the result decides too: Codex fires PostToolUse on a non-zero exit (research 2026-10-21)
  const code = [hook?.tool_response?.exit_code, hook?.tool_response?.exitCode, hook?.tool_response?.metadata?.exit_code].find((c) => Number.isInteger(c));
  const failed = ev === "PostToolUseFailure" || hook?.tool_response?.interrupted === true || (Number.isInteger(code) && code !== 0);
  const at = new Date().toISOString();
  if (EDIT.has(name)) {
    const path = show(input.file_path ?? input.notebook_path ?? hook?.tool_response?.filePath ?? "", cwd, instructionLike);
    return { op: "edit", target: path, obs: { op: "edit", path, ...lineCounts(hook.tool_response, input), ok: !failed, ...(failed ? { err: firstError(hook.error, instructionLike) } : {}), at } };
  }
  if (name === "Bash") {
    const cmd = commandKey(input.command), exit = Number.isInteger(code) ? code : failed ? Number((/Exit code (\d+)/i.exec(String(hook.error ?? "")) ?? [])[1] ?? 1) : 0;
    const interrupted = hook?.is_interrupt === true || hook?.tool_response?.interrupted === true;
    const denied = failed && DENIED.test(String(hook.error ?? ""));
    // a check that "succeeded" through a pipe can still have failed: its runner's summary decides
    const summary = !failed && checkKey(input.command) ? checkOutcome(hook?.tool_response?.stdout, hook?.tool_response?.stderr) : null;
    const bad = failed || summary?.ok === false;
    // a failure decided by the exit code alone (Codex, Cursor) has no hook error text: the runner's own output names it (review 2026-10-21)
    // stdout is read only for a check (its runner's summary); for any other command only stderr can name the error
    const out = hook?.tool_response ?? {}, byExit = failed && hook.error == null, isCheck = !!checkKey(input.command);
    const fromOutput = byExit ? (isCheck ? checkOutcome(out.stdout, out.stderr)?.line ?? (out.stderr || out.stdout) : out.stderr) : null;
    const err = summary?.ok === false ? firstError(summary.line, instructionLike, { fallback: true }) : failed && !denied ? firstError(hook.error ?? fromOutput ?? out.stderr, instructionLike, { fallback: isCheck }) : null;
    return { op: "run", target: cmd, obs: { op: "run", cmd, ok: !bad, exit: denied ? null : exit, ...(denied ? { denied: true } : {}), ...(interrupted ? { interrupted: true } : {}),
                                            ...(summary ? { by: "summary" } : {}), ...(err ? { err } : {}), at } };
  }
  if (name === "Read") { const path = show(input.file_path ?? "", cwd, instructionLike); return { op: "read", target: path, obs: { op: "read", path, ok: !failed, at } }; }
  if (name === "Grep" || name === "Glob" || name === "TodoWrite") return null;          // searches and to-do lists say little later
  return { op: "tool", target: one(name, 80), obs: { op: "tool", name: one(name, 80), ok: !failed, at } };
}

export function cliCapture(core) {
  try {
    let raw = ""; try { raw = readFileSync(0, "utf8"); } catch { /* no stdin */ }
    let hook; try { hook = JSON.parse(raw); } catch { return 0; }
    if (core.normalize) hook = core.normalize(hook);
    const o = observe(hook, core); if (!o) return 0;
    const path = episodePath(core.ledgerPath(), hook.session_id); mkdirSync(dirname(path), { recursive: true });
    // one tool call is one observation, even when two hosts read the same settings file and both run the hook (Continue's cn reads
    // ~/.claude/settings.json; research 2026-10-21)
    const id = typeof hook.tool_use_id === "string" && hook.tool_use_id ? hook.tool_use_id.slice(0, 120) : null;
    const seen = (p) => readFileSync(p, "utf8").slice(-200000).includes(`"id":${JSON.stringify(id)}`);
    core.chainAppend(path, { cause: o.op, effect: o.target || o.op, kind: "observation", tags: ["capture", o.op], obs: { ...o.obs, ...(id ? { id } : {}) } }, id ? { unless: seen } : {});
  } catch { /* a capture hook never fails a tool call */ }
  return 0;
}

const readRows = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);

// the files a fix names, most likely first: those sharing a name stem with the check's targets (test_cart.py <-> cart.py), then code,
// then the rest (notes and docs edited in the same stretch are kept, last)
const CODE = /\.(?:py|js|mjs|cjs|ts|tsx|jsx|rs|go|rb|java|kt|cs|php|swift|c|cc|cpp|h|hpp|sql|sh)$/i;
const stemOf = (p) => String(p).split("/").pop().replace(/\.[^.]+$/, "").replace(/^test_|_test$|\.test$|\.spec$/g, "").toLowerCase();
function rankFiles(files, key) {
  const stems = new Set(String(key).split(" ").slice(1).map(stemOf));
  const score = (p) => (stems.has(stemOf(p)) ? 0 : CODE.test(p) ? 1 : 2);
  return files.map((p, i) => [score(p), i, p]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
}

/** Findings an episode supports. Pure over the episode rows. Open threads only when the session is over (final). */
export function findings(rows, session, { final = true } = {}) {
  const obs = rows.filter((r) => r.kind === "observation" && r.obs);
  const out = [], lastFail = new Map(), editsSince = new Map(), lastRun = new Map();
  for (const r of obs) {
    const o = r.obs;
    if (o.op === "edit" && o.ok) for (const [k, list] of editsSince) list.push(r);
    if (o.op !== "run" || !o.cmd || o.denied || o.interrupted) continue;
    const k = checkKey(o.cmd); if (!k) continue;
    lastRun.set(k, r);
    if (!o.ok) { if (!lastFail.has(k)) { lastFail.set(k, r); editsSince.set(k, []); } continue; }
    if (lastFail.has(k)) {
      const f = lastFail.get(k), edits = editsSince.get(k), files = rankFiles([...new Set(edits.map((e) => e.obs.path).filter(Boolean))], k);
      out.push({ type: files.length ? "fix" : "flaky", cmd: k, key: `${session}|fix|${k}|${f.t}`,
                 cause: `\`${k}\` failed: ${f.obs.err || `exit ${f.obs.exit}`}`,
                 effect: files.length ? `passed after editing ${files.slice(0, 4).join(", ")}${files.length > 4 ? ` and ${files.length - 4} more` : ""}` : "passed on a re-run with no edits in between (flaky?)",
                 rows: [f, ...edits, r] });
      lastFail.delete(k); editsSince.delete(k);
    }
  }
  if (final) for (const [cmd, f] of lastFail) if (lastRun.get(cmd) === f || !lastRun.get(cmd)?.obs.ok)
    out.push({ type: "open", cmd, key: `${session}|open|${cmd}`, cause: `\`${cmd}\` still failing`, effect: f.obs.err || `exit ${f.obs.exit}`, rows: [f] });
  return out;
}

/**
 * Credit from an episode since row `since`: every memory shown (an exposure row's ts) or withheld (its held) is credited with the first
 * check outcome after it, as [shown passes, shown failures, withheld passes, withheld failures] (lib/weights.mjs); denials, interruptions
 * and non-checks credit nothing. A memory shown at any prompt before that check counts as shown, even if it was withheld at another: the
 * agent saw it. Each session is one trial per memory (the session is what withholding randomizes, and checks within a session are
 * correlated: counting every one made the intervals about 1.5x too narrow across 12 placebo seeds), so a memory already credited in this
 * session (`done`, from earlier consolidations) is not credited again. `through` only moves past rows whose exposures were all credited,
 * so a memory injected near the end of a turn is credited by the next consolidation, once.
 */
export function credits(rows, since = 0, done = new Set()) {
  const shown = new Set(), held = new Set(), out = new Map(), used = []; let through = since;
  for (const r of rows) {
    if (!(r.t > since) || !r.obs) continue;
    const o = r.obs;
    if (o.op === "exposure") { for (const t of o.ts ?? []) if (Number.isInteger(t)) shown.add(t); for (const t of o.held ?? []) if (Number.isInteger(t)) held.add(t); }
    else if (o.op === "run" && o.cmd && !o.denied && !o.interrupted && checkKey(o.cmd) && (shown.size || held.size)) {
      const credit = (t, arm) => { if (done.has(t) || out.has(t)) return; const c = [0, 0, 0, 0]; c[arm + (o.ok ? 0 : 1)]++; out.set(t, c); };
      for (const t of shown) credit(t, 0); for (const t of held) if (!shown.has(t)) credit(t, 2);
      shown.clear(); held.clear(); used.push(r);
    }
    if (!shown.size && !held.size) through = r.t;
  }
  return { credit: Object.fromEntries(out), through, rows: used };
}


// The machine a credit row was earned on: a random id kept in ~/.config/memory-pulse/machine-id (not the telemetry install id, which
// must never reach a ledger people commit). Credit from two machines on one ledger is how pooling is seen (lib/weights.mjs pooled).
export function machineId() {
  const p = join(homedir(), ".config", "memory-pulse", "machine-id");
  try { const v = readFileSync(p, "utf8").trim(); if (/^[0-9a-f]{12}$/.test(v)) return v; } catch { /* first use */ }
  try { const v = randomBytes(6).toString("hex"); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, v + "\n", { mode: 0o600, flag: "wx" }); return v; }
  catch { try { const v = readFileSync(p, "utf8").trim(); return /^[0-9a-f]{12}$/.test(v) ? v : null; } catch { return null; } }
}

export function sessionSummary(rows, session) {
  const obs = rows.filter((r) => r.kind === "observation" && r.obs);
  const files = [...new Set(obs.filter((r) => r.obs.op === "edit" && r.obs.ok).map((r) => r.obs.path))];
  const runs = obs.filter((r) => r.obs.op === "run"), failed = runs.filter((r) => !r.obs.ok).length;
  return { key: `${session}|session`, cause: `session ${String(session).slice(0, 12)}`,
           effect: `edited ${files.length} file${files.length === 1 ? "" : "s"}${files.length ? ` (${files.slice(0, 5).join(", ")}${files.length > 5 ? ", …" : ""})` : ""}; ran ${runs.length} command${runs.length === 1 ? "" : "s"}, ${failed} failed`,
           rows: obs.length ? [obs[0], obs.at(-1)] : [] };
}

export function cliConsolidate(argv, core) {
  try {
    let raw = ""; try { raw = readFileSync(0, "utf8"); } catch { /* no stdin */ }
    let hook = {}; try { hook = raw.trim() ? JSON.parse(raw) : {}; } catch { hook = {}; }
    if (core.normalize) hook = core.normalize(hook);
    const session = hook.session_id; if (!session) return 0;
    const path = episodePath(core.ledgerPath(), session); const rows = readRows(path); if (!rows.length) return 0;
    const events = core.readEvents().events, have = new Set(events.map((e) => e.capture_key).filter(Boolean));
    // open threads from any session of this project, until a fix or a passing run of the same check resolves them (`resolves`; the
    // ledger's `supersedes` belongs to corrections, and appendEvent dropped it here, so no thread was ever retired: review 2026-10-21)
    const resolved = new Set(events.flatMap((e) => (Array.isArray(e.resolves) ? e.resolves : [])));
    const openRows = new Map();
    for (const e of events) if ((e.tags ?? []).includes("open") && e.capture_key && !resolved.has(e.t)) { const cmd = e.capture_key.split("|").slice(2).join("|"); openRows.set(cmd, [...(openRows.get(cmd) ?? []), e.t]); }
    const evidence = (rs) => ({ episode: session, rows: rs.map((r) => r.t), head: rs.at(-1)?.hash ?? null });
    const screened = (v) => (core.instructionLike && unsafe(String(v ?? ""), core.instructionLike) ? "(withheld: it reads like an instruction)" : v);
    let n = 0; const closed = new Set();
    for (const f of findings(rows, session, { final: argv.includes("--final") })) {
      if (have.has(f.key)) continue;
      const resolves = f.type !== "open" ? openRows.get(f.cmd) : undefined;
      const r = core.appendEvent({ cause: screened(f.cause), effect: screened(f.effect), kind: "event", tags: ["captured", f.type],
                                   fields: { capture_key: f.key, evidence: evidence(f.rows), ...(resolves ? { resolves } : {}) } });
      if (r.written) { n++; if (resolves) closed.add(f.cmd); }
    }
    // a thread left open by an earlier session is also closed when this session's last run of that check passed
    for (const [cmd, ts] of openRows) {
      if (closed.has(cmd)) continue;
      const last = [...rows].reverse().find((r) => r.obs?.op === "run" && !r.obs.denied && !r.obs.interrupted && r.obs.cmd && checkKey(r.obs.cmd) === cmd);
      if (!last?.obs.ok) continue;
      const key = `${session}|resolved|${cmd}|${ts.join(",")}`; if (have.has(key)) continue;
      const r = core.appendEvent({ cause: `\`${cmd}\` passes again`, effect: "the open thread is closed", kind: "event", tags: ["captured", "resolved"],
                                   fields: { capture_key: key, evidence: evidence([last]), resolves: ts } });
      if (r.written) n++;
    }
    // credit (2026-10-21): injected memories scored by the next check outcome, as summable counts on the ledger (lib/weights.mjs)
    const mine = events.filter((e) => (e.tags ?? []).includes("credit") && e.evidence?.episode === session);
    const prior = mine.reduce((m, e) => Math.max(m, Number(e.evidence?.through) || 0), 0), done = new Set(mine.flatMap((e) => Object.keys(e.credit ?? {}).map(Number)));
    const c = credits(rows, prior, done);
    if (Object.keys(c.credit).length) {
      const key = `${session}|credit|${c.through}`;
      if (!have.has(key)) { const r = core.appendEvent({ cause: "credit", effect: `session ${String(session).slice(0, 12)} through t${c.through}`, kind: "event", tags: ["credit"], fields: { capture_key: key, credit: c.credit, evidence: { ...evidence(c.rows), through: c.through, ...(machineId() ? { machine: machineId() } : {}) } } }); if (r.written) n++; }
    }
    if (argv.includes("--final")) {
      const s = sessionSummary(rows, session);
      if (!have.has(s.key)) { const r = core.appendEvent({ cause: s.cause, effect: s.effect, kind: "event", tags: ["captured", "session"], fields: { capture_key: s.key, evidence: evidence(s.rows) } }); if (r.written) n++; }
      const b = core.buildCapsule({ ledger: path, scope: "episode" });
      if (b.capsule) writeFileSync(path.replace(/\.jsonl$/, ".rain"), JSON.stringify(b.capsule, null, 2) + "\n");
    }
    if (n && argv.includes("--verbose")) console.log(`memory-pulse: ${n} finding(s) from this session`);
  } catch { /* a consolidate hook never blocks a stop, a compaction or an exit */ }
  return 0;
}
