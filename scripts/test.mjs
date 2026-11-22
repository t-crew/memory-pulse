#!/usr/bin/env node
// Runs the suite (or the test files named as arguments) with the caller's ledger, project, board and key variables cleared.
// A shell that exports MEMORY_PULSE_LEDGER (every Claude Code process on a machine that sets it in settings.json does) used to
// hand the suite a real ledger: 5 test rows and a quarantine folder were written into one before any gate failed (review
// 2026-11-21, T-1). `npm test` and scripts/release.sh both run this file. Node only, so it behaves the same on every platform.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CLEARED = ["MEMORY_PULSE_LEDGER", "MP_LEDGER", "MEMORY_PULSE_PROJECT", "MEMORY_PULSE_BOARD", "MEMORY_PULSE_KEY"];
export function cleanEnv(env = process.env) { const e = { ...env }; for (const k of CLEARED) delete e[k]; return e; }

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const named = process.argv.slice(2);
  const files = named.length ? named : readdirSync(join(root, "test")).filter((f) => f.endsWith(".test.js")).sort().map((f) => join("test", f));
  const r = spawnSync(process.execPath, ["--test", ...files], { cwd: named.length ? process.cwd() : root, env: cleanEnv(), stdio: "inherit" });
  process.exit(r.status ?? 1);
}
