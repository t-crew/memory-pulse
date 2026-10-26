// One tool call for `memory-pulse http` (lib/remote.mjs), in a process of its own. The parent gives it one person's key,
// project and a temporary folder through the environment, and the call ({ name, args }) on stdin; it answers one JSON
// line on stdout: { ok: true, result } or { ok: false, error }.
//
//   1. pull: the project's hosted ledger (GET /v1/state), verified as a capsule, written into the folder as it is. Not
//      through `state import`, which records a state-resumed row: that row would be pushed back on every call.
//   2. call: the same handleCall the stdio server runs, so every rule (the write-time gate, the instruction screen, the
//      chain) is the one the person already has on their own machine.
//   3. push: after a `remember` that wrote a row, the ledger goes back as a capsule (POST /v1/state). A push the engine
//      refuses is an error: the call says the row was not kept, never that it was.
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// the temporary folder means nothing to the caller and names this server's disk: every mention of it becomes the hosted ledger
// (the folder as the parent named it, HOME, and as the system resolved it, the cwd: they differ where /tmp is a link)
const reply = (v) => {
  let text = JSON.stringify(v);
  for (const dir of new Set([process.env.HOME, process.cwd()].filter((d) => d && d.length > 4))) text = text.split(JSON.stringify(dir).slice(1, -1)).join(`hosted:${process.env.MEMORY_PULSE_PROJECT}`);
  process.stdout.write(text);
};

async function main() {
  let job; try { job = JSON.parse(readFileSync(0, "utf8")); } catch { return reply({ ok: false, error: "worker got no call" }); }
  const S = await import("../server.mjs");
  const ledger = process.env.MEMORY_PULSE_LEDGER, project = process.env.MEMORY_PULSE_PROJECT;
  const url = `${S.API}/v1/state?project=${encodeURIComponent(project)}`;
  const headers = { "x-mp-key": process.env.MEMORY_PULSE_KEY };
  const said = async (res) => { try { return await res.json(); } catch { return {}; } };

  let res;
  try { res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) }); }
  catch (e) { return reply({ ok: false, error: `the hosted ledger could not be reached (${e?.cause?.code ?? e?.name ?? "error"}); nothing was read or recorded` }); }
  const pulled = await said(res);
  if (!res.ok && res.status !== 404) return reply({ ok: false, error: `the hosted ledger refused the read (${res.status}${pulled.error ? `: ${pulled.error}` : ""}); nothing was recorded` });
  let rows = 0;
  if (res.ok && Array.isArray(pulled.lines) && pulled.lines.length) {
    const v = S.verifyCapsule(pulled);
    if (!v.ok) return reply({ ok: false, error: `the hosted ledger did not verify (${v.reason}); nothing was read or recorded` });
    mkdirSync(dirname(ledger), { recursive: true });
    writeFileSync(ledger, pulled.lines.join("\n") + "\n");
    if (pulled.seal && typeof pulled.seal.head === "string") writeFileSync(join(dirname(ledger), "seal.rain"), JSON.stringify(pulled.seal, null, 2) + "\n");
    if (Array.isArray(pulled.invariants) && pulled.invariants.length) writeFileSync(join(dirname(ledger), "invariants.jsonl"), pulled.invariants.map((i) => JSON.stringify(i)).join("\n") + "\n");
    rows = pulled.lines.length;
  }

  let result;
  try { result = await S.handleCall(job.name, job.args ?? {}); }
  catch (e) { return reply({ ok: false, error: String(e?.message ?? e) }); }

  if (job.name === "remember" && result && result.written !== false) {
    const b = S.buildCapsule({ ledger });
    if (b.error) return reply({ ok: false, error: `the row was written here but could not be packed for the hosted ledger (${b.error}); it was not kept` });
    let p;
    try { p = await fetch(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(b.capsule), signal: AbortSignal.timeout(20_000) }); }
    catch (e) { return reply({ ok: false, error: `the hosted ledger could not be reached (${e?.cause?.code ?? e?.name ?? "error"}); the row was not kept` }); }
    const pushed = await said(p);
    if (!p.ok) return reply({ ok: false, error: `the hosted ledger refused the write (${p.status}${pushed.error ?? pushed.reason ? `: ${pushed.error ?? pushed.reason}` : ""}); the row was not kept` });
    result = { ...result, ledger: `hosted:${project}`, hosted: { status: pushed.status ?? "ok", rows: pushed.rows ?? null } };
  } else if (result && typeof result === "object" && "ledger" in result) {
    result = { ...result, ledger: `hosted:${project}` };   // never a temporary path the caller cannot use
  }
  reply({ ok: true, result, pulled: rows });
}

main().catch((e) => reply({ ok: false, error: String(e?.message ?? e) }));
