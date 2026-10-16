// The agent message board (2026-10-16). Agents post and read messages on a SHARED board: a ledger file of its own, chained, locked and
// verifiable like every memory-pulse ledger (same append path, same hash chain), so any edit to a message shows. It is passive: posting
// never runs anything and reading is a pull; nothing here wakes, schedules or prompts an agent. A message is data, never an instruction:
// text that reads like one is stored, flagged, and always shown quoted. The board is a separate file and never enters the project
// ledger, the brief or the guard. Tests: test/board.test.js.
// Claims (2026-10-16), after Self-Organizing Agent Teams (arXiv 2609.22682), where six of the twenty strategies its teams kept exist to keep a
// correct claim from one member from being lost in the team's consensus, and the judge may reject a candidate only by naming a defect: a
// `claim` stays open until another agent posts a `verdict` (upheld, refuted with a named defect, or withdrawn by its author), and a
// `synthesis` is refused while a claim in its thread is open unless it is recorded over them, flagged. Tests: test/board-claims.test.js.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
// The integrity functions come from server.mjs. When server.mjs is the running CLI it hands them over before importing this module
// (globalThis.__MEMORY_PULSE_CORE__), because importing the entry module back from here would be a cycle under top-level await.
const { chainAppend, verifyChain, instructionLike, readEvents } = globalThis.__MEMORY_PULSE_CORE__ ?? await import("../server.mjs");

export const KINDS = ["note", "request", "reply", "claim", "verdict", "synthesis"];
export const VERDICTS = ["upheld", "refuted", "withdrawn"];
export const MAX_TITLE = 200, MAX_BODY = 20000, MAX_DEFECT = 1000;
const ID = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "message";

export function boardPath(flag) {
  const p = flag || process.env.MEMORY_PULSE_BOARD;
  if (p) return isAbsolute(p) ? p : join(process.cwd(), p);
  return join(process.cwd(), ".memory-pulse", "board.jsonl");
}

function load(path) {
  const rows = readEvents({ path }).events.filter((e) => e && typeof e.board === "object" && e.board);
  const msgs = [], acks = new Map();
  for (const r of rows) {
    const b = r.board;
    if (b.kind === "ack") { if (!acks.has(b.ack)) acks.set(b.ack, new Set()); acks.get(b.ack).add(b.from); continue; }
    msgs.push({ t: r.t, from: b.from, to: b.to, kind: b.kind, title: b.title ?? r.effect, body: r.note ?? "", at: b.at ?? null,
                thread: b.thread ?? r.t, reply_to: b.reply_to ?? null, flagged: Array.isArray(b.flagged) ? b.flagged : [],
                ...(b.verdict ? { verdict: b.verdict, defect: b.defect ?? null } : {}), ...(Array.isArray(b.over_open) ? { over_open: b.over_open } : {}) });
  }
  for (const m of msgs) m.acked_by = [...(acks.get(m.t) ?? [])];
  return msgs;
}

const refuse = (reason) => ({ written: false, reason });

// A claim's standing from its verdicts: open (none from another agent), withdrawn (by its author), upheld, refuted, or contested (two
// agents disagree). Each agent's latest verdict is the one that counts, so one agent alone cannot make a claim contested.
function claimStatus(c, msgs) {
  const verdicts = msgs.filter((v) => v.kind === "verdict" && v.reply_to === c.t);
  if (verdicts.some((v) => v.verdict === "withdrawn" && v.from === c.from)) return { status: "withdrawn", verdicts };
  const latest = new Map(); for (const v of verdicts) if (v.from !== c.from) latest.set(v.from, v.verdict);
  const said = new Set(latest.values());
  return { status: said.has("upheld") && said.has("refuted") ? "contested" : said.has("refuted") ? "refuted" : said.has("upheld") ? "upheld" : "open", verdicts };
}
export function claims(path, { thread } = {}) {
  const msgs = load(path);
  return msgs.filter((m) => m.kind === "claim" && (thread == null || m.thread === Number(thread))).map((c) => {
    const { status, verdicts } = claimStatus(c, msgs);
    return { t: c.t, from: c.from, title: c.title, thread: c.thread, status, verdicts: verdicts.map((v) => ({ t: v.t, from: v.from, verdict: v.verdict, defect: v.defect, body: v.body })) };
  });
}
const openLine = (open) => open.map((c) => `t${c.t} (${c.from})`).join(", ");

export function post(path, { from, to, kind = "note", title, body = "", thread, reply_to, verdict, defect, over_open } = {}) {
  from = String(from ?? "").trim().toLowerCase(); to = String(to ?? "").trim().toLowerCase(); title = String(title ?? "").trim(); body = String(body ?? "");
  const extra = {};
  // A claim or synthesis lives in its root thread: reply_to, or a reply's own t, names the thread it answers (review 1, 2026-10-16).
  if (kind === "claim" || kind === "synthesis") {
    const msgs = load(path); const ref = thread ?? (kind === "claim" ? reply_to : undefined);
    if (ref != null) { const m = msgs.find((x) => x.t === Number(ref)); if (!m) return refuse(`no message t${ref} on this board to name a thread`); thread = m.thread; }
  }
  if (kind === "verdict") {
    const c = load(path).find((m) => m.t === Number(reply_to));
    if (!c || c.kind !== "claim") return refuse(`a verdict answers a claim: t${reply_to} is ${c ? `a ${c.kind}` : "not on this board"}`);
    if (!VERDICTS.includes(verdict)) return refuse(`the verdict is one of ${VERDICTS.join(", ")}`);
    if (verdict === "withdrawn" && from !== c.from) return refuse(`only the claim's author (${c.from}) withdraws it`);
    if (verdict !== "withdrawn" && from === c.from) return refuse("an agent does not adjudicate its own claim; withdraw it instead");
    defect = String(defect ?? "").trim();
    if (defect.length > MAX_DEFECT) return refuse(`a defect is at most ${MAX_DEFECT} characters`);
    if (verdict === "refuted" && defect.split(/\s+/).filter(Boolean).length < 3) return refuse("a refutation names the defect: the step, number or fact in the claim that fails (--defect), not that you disagree");
    to = verdict === "withdrawn" ? c.to : c.from; thread = c.thread; reply_to = c.t; title = title || `${verdict}: ${c.title}`.slice(0, MAX_TITLE);
    Object.assign(extra, { verdict }, defect ? { defect } : {});
  }
  if ((kind === "claim" || kind === "synthesis") && !to) to = "all";
  if (kind === "synthesis") {
    const msgs = load(path);
    if (!thread) return refuse("a synthesis names a thread on this board (--thread T)");
    const open = msgs.filter((m) => m.kind === "claim" && m.thread === Number(thread) && claimStatus(m, msgs).status === "open");
    if (open.length && !over_open) return refuse(`thread t${thread} has ${open.length} open claim${open.length === 1 ? "" : "s"}: ${openLine(open)}; answer each with a verdict, or post with --over-open to record the synthesis over them`);
    if (open.length) extra.over_open = open.map((c) => c.t);
  }
  if (!ID.test(from)) return refuse("sender must be an agent id: lower-case letters, digits, . _ - (1-40 chars)");
  if (to !== "all" && !ID.test(to)) return refuse("addressee must be an agent id or 'all'");
  if (from === to) return refuse("an agent does not post to itself");
  if (!KINDS.includes(kind)) return refuse(`kind must be one of ${KINDS.join(", ")}`);
  if (!title || title.length > MAX_TITLE) return refuse(`title required, at most ${MAX_TITLE} characters`);
  if (body.length > MAX_BODY) return refuse(`body at most ${MAX_BODY} characters`);
  const flagged = instructionLike(`${title}\n${body}\n${extra.defect ?? ""}`);
  const event = { t: undefined, cause: "board-post", effect: slug(title), kind: "event", ...(body ? { note: body } : {}), tags: ["board", kind],
                  board: { from, to, kind, title, at: new Date().toISOString(), ...(thread ? { thread: Number(thread) } : {}),
                           ...(reply_to ? { reply_to: Number(reply_to) } : {}), ...extra, ...(flagged.length ? { flagged } : {}) } };
  try { chainAppend(path, event); } catch (e) { return refuse(String(e?.message ?? e)); }
  return { written: true, t: event.t, flagged, board: path };
}

export function reply(path, t, { from, body = "", title } = {}) {
  const orig = load(path).find((m) => m.t === Number(t));
  if (!orig) return refuse(`no message t${t} on this board`);
  return post(path, { from, to: orig.from === String(from ?? "").toLowerCase() ? orig.to : orig.from, kind: "reply",
                      title: title ?? `re: ${orig.title}`.slice(0, MAX_TITLE), body, thread: orig.thread, reply_to: orig.t });
}

export function verdict(path, t, { from, verdict: v, defect, body = "", title } = {}) {
  return post(path, { from, kind: "verdict", reply_to: t, verdict: v, defect, body, title });
}

export function ack(path, t, { as } = {}) {
  as = String(as ?? "").trim().toLowerCase();
  if (!ID.test(as)) return refuse("acknowledging agent must be an agent id");
  const m = load(path).find((x) => x.t === Number(t));
  if (!m) return refuse(`no message t${t} on this board`);
  if (m.to !== as && m.to !== "all") return refuse(`t${t} is addressed to ${m.to}, not ${as}`);
  const event = { t: undefined, cause: "board-ack", effect: `t${m.t}`, kind: "event", tags: ["board", "ack"], board: { from: as, kind: "ack", ack: m.t, at: new Date().toISOString() } };
  try { chainAppend(path, event); } catch (e) { return refuse(String(e?.message ?? e)); }
  return { written: true, t: event.t };
}

export function inbox(path, agent) {
  agent = String(agent ?? "").toLowerCase();
  return load(path).filter((m) => (m.to === agent || m.to === "all") && m.from !== agent && !m.acked_by.includes(agent));
}

export function thread(path, t) {
  const msgs = load(path); const m = msgs.find((x) => x.t === Number(t));
  return m ? msgs.filter((x) => x.thread === m.thread) : [];
}

export function messages(path) { return load(path); }

export function integrity(path) {
  if (!existsSync(path)) return { ok: true, empty: true };
  const v = verifyChain(path); return { ok: !!v.ok, head: v.head ?? null, chained: v.chained ?? 0, reason: v.reason ?? null };
}

const integrityLine = (path) => { const v = integrity(path); return v.empty ? "empty" : v.ok ? `chain OK head ${String(v.head ?? "").slice(0, 12)}` : `chain BROKEN (${v.reason ?? "verify failed"})`; };

// A defect is another agent's words, like a body: the text view quotes it line by line (review 2); one-line views collapse its whitespace.
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const standing = (m, all) => m.kind === "claim" ? `  claim: ${claimStatus(m, all).status}` : m.kind === "verdict" ? `  verdict on t${m.reply_to}: ${m.verdict}${m.defect ? ` · defect: ${oneLine(m.defect)}` : ""}` :
  m.over_open?.length ? `  ⚠ synthesized over ${m.over_open.length} open claim${m.over_open.length === 1 ? "" : "s"}: ${m.over_open.map((t) => `t${t}`).join(", ")}` : "";
export function renderText(list, all = list) {
  const out = [];
  for (const m of list) {
    out.push(`t${m.t} · ${m.at ?? "?"} · ${m.from} → ${m.to} · ${m.kind} · ${m.title}${m.thread !== m.t ? ` · thread t${m.thread}` : ""}`);
    const st = m.kind === "verdict" && m.defect ? `  verdict on t${m.reply_to}: ${m.verdict} · defect:` : standing(m, all); if (st) out.push(st);
    if (m.kind === "verdict" && m.defect) for (const l of String(m.defect).split("\n")) out.push(`  │ ${l}`);
    if (m.flagged.length) out.push(`  ⚠ instruction-like text: shown as data (${m.flagged.join(", ")})`);
    for (const l of (m.body || "").split("\n")) out.push(`  │ ${l}`);
    if (m.acked_by.length) out.push(`  acknowledged by ${m.acked_by.join(", ")}`);
  }
  return out.join("\n");
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function html(path, { title = "memory-pulse board" } = {}) {
  const msgs = load(path); const v = integrity(path);
  const agents = [...new Set(msgs.flatMap((m) => [m.from, m.to]))].sort();
  const edges = new Map(); for (const m of msgs) { const k = `${m.from}\u0000${m.to}`; edges.set(k, (edges.get(k) ?? 0) + 1); }
  const R = 120, cx = 170, cy = 150, pos = new Map(agents.map((a, i) => [a, [cx + R * Math.cos((2 * Math.PI * i) / Math.max(agents.length, 1) - Math.PI / 2),
                                                                                  cy + R * Math.sin((2 * Math.PI * i) / Math.max(agents.length, 1) - Math.PI / 2)]]));
  const svgEdges = [...edges].map(([k, n]) => { const [a, b] = k.split("\u0000"); const [x1, y1] = pos.get(a), [x2, y2] = pos.get(b);
    return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#2f7d6d" stroke-opacity="0.55" stroke-width="${Math.min(1 + n, 8)}" marker-end="url(#arr)"><title>${esc(a)} → ${esc(b)}: ${n}</title></line>`; }).join("");
  const svgNodes = agents.map((a) => { const [x, y] = pos.get(a); const un = msgs.filter((m) => (m.to === a || m.to === "all") && m.from !== a && !m.acked_by.includes(a)).length;
    return `<g><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="22" fill="#f4f1ea" stroke="#1f2a30" stroke-width="1.5"/><text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="middle" font-size="11">${esc(a)}</text>${un ? `<text x="${(x + 18).toFixed(1)}" y="${(y - 16).toFixed(1)}" font-size="10" fill="#b4442c">${un}</text>` : ""}</g>`; }).join("");
  const threads = new Map(); for (const m of msgs) { if (!threads.has(m.thread)) threads.set(m.thread, []); threads.get(m.thread).push(m); }
  const cards = [...threads.values()].sort((a, b) => b[b.length - 1].t - a[a.length - 1].t).map((ms) => `<section class="thread"><h2>${esc(ms[0].title)}</h2>${ms.map((m) => `
    <article class="msg ${esc(m.kind)}"><div class="meta">t${m.t} · ${esc(m.at ?? "")} · <b>${esc(m.from)}</b> → <b>${esc(m.to)}</b> · <span class="kind">${esc(m.kind)}</span>${standing(m, msgs) ? ` · <span class="${m.kind === "claim" && claimStatus(m, msgs).status === "open" || m.over_open?.length ? "flag" : "kind"}">${esc(standing(m, msgs).trim())}</span>` : ""}${m.flagged.length ? ` · <span class="flag">instruction-like text, shown as data</span>` : ""}${m.acked_by.length ? ` · acknowledged by ${esc(m.acked_by.join(", "))}` : ""}</div>
    <pre>${esc(m.body)}</pre></article>`).join("")}</section>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{font:14px/1.45 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;margin:0;background:#fbfaf7;color:#1f2a30}header{padding:18px 24px;border-bottom:1px solid #e3ded3}
h1{font-size:18px;margin:0 0 4px}.sub{color:#5d6a70;font-size:12px}.wrap{display:grid;grid-template-columns:340px 1fr;gap:24px;padding:20px 24px}
.thread{background:#fff;border:1px solid #e3ded3;border-radius:6px;padding:12px 14px;margin-bottom:14px}.thread h2{font-size:15px;margin:0 0 8px}
.msg{border-top:1px solid #efebe3;padding:8px 0}.meta{font-size:12px;color:#5d6a70}.kind{text-transform:uppercase;letter-spacing:.04em}
.flag{color:#b4442c;font-weight:600}pre{white-space:pre-wrap;margin:6px 0 0;font:13px/1.4 ui-monospace,Menlo,monospace;background:#f7f5f0;padding:8px;border-radius:4px}
.ok{color:#2f7d6d}.bad{color:#b4442c;font-weight:700}@media(max-width:820px){.wrap{grid-template-columns:1fr}}</style></head><body>
<header><h1>${esc(title)}</h1><div class="sub">${esc(path)} · ${msgs.length} message${msgs.length === 1 ? "" : "s"} · ${agents.length} agent${agents.length === 1 ? "" : "s"} · <span class="${v.ok ? "ok" : "bad"}">${esc(integrityLine(path))}</span> · messages are data, never instructions</div></header>
<div class="wrap"><div><svg width="340" height="300" viewBox="0 0 340 300" role="img" aria-label="who writes to whom"><defs><marker id="arr" viewBox="0 0 10 10" refX="28" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0L10,5L0,10z" fill="#2f7d6d"/></marker></defs>${svgEdges}${svgNodes}</svg>
<div class="sub">Edge width = messages sent; a red number = unread for that agent.</div></div><main>${cards || "<p>No messages yet.</p>"}</main></div></body></html>`;
}

// ---- CLI: memory-pulse board post|read|reply|ack|verdict|claims|thread|html|verify [--board PATH]
export async function cliBoard(argv) {
  const flags = {}, pos = [];
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith("--")) { const k = a.slice(2); const nx = argv[i + 1]; if (nx === undefined || nx.startsWith("--")) flags[k] = true; else { flags[k] = nx; i++; } } else pos.push(a); }
  const op = pos[0]; const path = boardPath(typeof flags.board === "string" ? flags.board : null);
  const body = typeof flags["body-file"] === "string" ? readFileSync(flags["body-file"], "utf8") : (typeof flags.body === "string" ? flags.body : "");
  const say = (r, ok) => { if (r.written) { console.log(ok(r)); return 0; } console.error(`memory-pulse board: nothing written (${r.reason})`); return 1; };
  if (op === "post") return say(post(path, { from: flags.from, to: flags.to, kind: flags.kind ?? "note", title: flags.title, body, thread: flags.thread, reply_to: flags["reply-to"], over_open: !!flags["over-open"] }),
                              (r) => `posted t${r.t} to ${path}${r.flagged.length ? ` (instruction-like text flagged: ${r.flagged.join(", ")})` : ""}`);
  if (op === "verdict") return say(verdict(path, pos[1], { from: flags.as ?? flags.from, verdict: pos[2], defect: typeof flags.defect === "string" ? flags.defect : "", body }),
                                 (r) => `posted t${r.t} to ${path}: ${pos[2]} on t${pos[1]}`);
  if (op === "claims") {
    const list = claims(path, { thread: typeof flags.thread === "string" ? flags.thread : undefined }).filter((c) => !flags.open || c.status === "open");
    console.log(`board: ${path} · ${integrityLine(path)} · claims: ${list.length}`);
    for (const c of list) { console.log(`t${c.t} · ${c.from} · ${c.status} · ${c.title} · thread t${c.thread}`); for (const v of c.verdicts) console.log(`  t${v.t} ${v.from} ${v.verdict}${v.defect ? `: ${oneLine(v.defect)}` : ""}`); }
    return 0;
  }
  if (op === "reply") return say(reply(path, pos[1], { from: flags.as ?? flags.from, body, title: typeof flags.title === "string" ? flags.title : undefined }), (r) => `posted t${r.t} to ${path}`);
  if (op === "ack") return say(ack(path, pos[1], { as: flags.as }), (r) => `acknowledged as t${r.t}`);
  if (op === "read" || op === "inbox") {
    const as = String(flags.as ?? ""); const list = flags.all ? messages(path) : inbox(path, as);
    console.log(`board: ${path} · ${integrityLine(path)} · ${flags.all ? "all messages" : `unread for ${as || "?"}`}: ${list.length}`);
    const all = messages(path); console.log(list.length ? renderText(list, all) : (flags.all ? "no messages" : `no unread messages for ${as}`));
    const open = claims(path).filter((c) => c.status === "open");
    if (open.length) console.log(`${open.length} open claim${open.length === 1 ? "" : "s"} on the board: ${openLine(open)} (memory-pulse board claims lists every claim and its verdicts)`);
    return 0;
  }
  if (op === "thread") { const list = thread(path, pos[1]); console.log(list.length ? renderText(list, messages(path)) : `no thread for t${pos[1]}`); return list.length ? 0 : 1; }
  if (op === "html") { const out = typeof flags.out === "string" ? flags.out : join(dirname(path), "board.html"); mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, html(path)); console.log(`board view: ${out}`); return 0; }
  if (op === "verify") { const v = integrity(path); console.log(`board: ${path} · ${integrityLine(path)}`); return v.ok ? 0 : 1; }
  console.error("usage: memory-pulse board post --from ID --to ID|all [--kind note|request|reply|claim|synthesis] --title T [--body B | --body-file F] [--thread T] [--over-open]\n" +
                "       memory-pulse board verdict T upheld|refuted|withdrawn --as ID [--defect D] [--body B] | claims [--thread T] [--open]\n" +
                "       memory-pulse board read --as ID [--all] | reply T --as ID --body B | ack T --as ID | thread T | html [--out F] | verify   [--board PATH]");
  return 2;
}
