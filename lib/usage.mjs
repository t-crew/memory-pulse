// Opt-in usage counts (0.7.0): the answer to "is anyone using it" for installs that never call the engine.
// Nothing is counted before consent. With it, counts accumulate in ~/.memory-pulse/usage.rain and leave the machine
// at most once per UTC day, as eight integers plus a random install id, the version and the host. A kind that is not one
// of the eight is dropped at the door, so no text of any kind can reach the payload.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const USAGE_KINDS = ["guard_check", "guard_block", "remember", "lint", "check_local", "scaffold", "prompt_slice", "edit_slice"];
export const defaultDir = (env = process.env) => join(env.HOME || homedir(), ".memory-pulse");
const consentFile = (dir) => join(dir, "consent.json");
const usageFile = (dir) => join(dir, "usage.rain");
const readJson = (f, fallback) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return fallback; } };
const writeJson = (f, v, dir) => { mkdirSync(dir, { recursive: true }); writeFileSync(f, JSON.stringify(v, null, 2) + "\n"); };
const truthy = (v) => v === "1" || v === "true" || v === "yes";
const falsy = (v) => v === "0" || v === "false" || v === "off" || v === "no";

/** consentState({ dir, env }) -> { enabled, install, reason } */
export function consentState({ dir = defaultDir(), env = process.env } = {}) {
  if (truthy(env.DO_NOT_TRACK)) return { enabled: false, install: null, reason: "DO_NOT_TRACK is set" };
  if (falsy(env.MEMORY_PULSE_TELEMETRY)) return { enabled: false, install: null, reason: "MEMORY_PULSE_TELEMETRY is off" };
  const c = readJson(consentFile(dir), null);
  if (!c) return { enabled: false, install: null, reason: "no consent recorded (memory-pulse telemetry on)" };
  if (c.consent !== true || typeof c.install !== "string") return { enabled: false, install: null, reason: "consent is no" };
  return { enabled: true, install: c.install, reason: "consent recorded " + (c.at ?? "") };
}
export const hasConsentAnswer = ({ dir = defaultDir() } = {}) => existsSync(consentFile(dir));

/** setConsent(yes, { dir }) — a yes mints the install id (128 random bits) on first use; a no forgets it. */
export function setConsent(yes, { dir = defaultDir() } = {}) {
  const prior = readJson(consentFile(dir), {});
  const install = yes ? (typeof prior.install === "string" ? prior.install : randomBytes(16).toString("hex")) : null;
  writeJson(consentFile(dir), { consent: !!yes, install, at: new Date().toISOString() }, dir);
}

/** resetInstall({ dir }) — a new install id, zeroed counts, no capsule. */
export function resetInstall({ dir = defaultDir() } = {}) {
  const c = readJson(consentFile(dir), null);
  if (c?.consent === true) writeJson(consentFile(dir), { ...c, install: randomBytes(16).toString("hex"), at: new Date().toISOString() }, dir);
  writeJson(usageFile(dir), { pending: {}, capsule: null, lastSent: null }, dir);
}

/** recordUsage(kind, { dir, env }) — counts only after a yes (opt-in collects nothing before consent); never throws; unknown kinds dropped. */
export function recordUsage(kind, { dir = defaultDir(), env = process.env } = {}) {
  if (!USAGE_KINDS.includes(kind) || !consentState({ dir, env }).enabled) return;
  try {
    const u = readJson(usageFile(dir), { pending: {}, capsule: null, lastSent: null });
    u.pending = u.pending && typeof u.pending === "object" ? u.pending : {};
    u.pending[kind] = (Number.isInteger(u.pending[kind]) ? u.pending[kind] : 0) + 1;
    writeJson(usageFile(dir), u, dir);
  } catch { /* counting is a convenience; it must never break a hook */ }
}

export function detectHost(env = process.env) {
  if (env.CLAUDECODE || env.CLAUDE_PROJECT_DIR) return "claude";
  if (Object.keys(env).some((k) => k.startsWith("CODEX_"))) return "codex";
  return "other";
}

/** usagePayload({ dir, env, version, host }) -> the exact object a send would post, or null when sending is off */
export function usagePayload({ dir = defaultDir(), env = process.env, version, host } = {}) {
  const st = consentState({ dir, env });
  if (!st.enabled) return null;
  const u = readJson(usageFile(dir), { pending: {}, capsule: null });
  const counts = Object.fromEntries(USAGE_KINDS.filter((k) => Number.isInteger(u.pending?.[k]) && u.pending[k] > 0).map((k) => [k, u.pending[k]]));
  return { capsule: u.capsule ?? null, counts, host: host ?? detectHost(env), install: st.install, version };
}

/** maybeSendUsage({ dir, post, env, version, host, now, print }) — at most once per UTC day, only with consent; silent on failure. */
export async function maybeSendUsage({ dir = defaultDir(), post, env = process.env, version, host, now = Date.now(), print = (s) => process.stderr.write(s + "\n") } = {}) {
  try {
    const payload = usagePayload({ dir, env, version, host });
    if (!payload || !Object.keys(payload.counts).length) return;
    if (truthy(env.MEMORY_PULSE_TELEMETRY_DEBUG)) { print(JSON.stringify(payload, null, 2)); return; }
    const today = new Date(now).toISOString().slice(0, 10);
    const u = readJson(usageFile(dir), { pending: {}, capsule: null, lastSent: null });
    if (u.lastSent === today) return;
    const r = await post(payload);
    if (r?.status !== 200 || !r.body?.capsule) return;
    const after = readJson(usageFile(dir), u);
    const pending = { ...(after.pending ?? {}) };
    for (const [k, n] of Object.entries(payload.counts)) pending[k] = Math.max(0, (pending[k] ?? 0) - n);
    writeJson(usageFile(dir), { pending, capsule: r.body.capsule, lastSent: today }, dir);
  } catch { /* usage counts must never break a session start */ }
}
