// The ledger's layout on disk, and what a client does when it cannot read it (0.19.0).
// This client reads one layout: the chain in events.jsonl. A later release may keep the ledger another way and will say so in
// .memory-pulse/layout.json ({"layout": "<name>", "version": N}), committed beside it. An engineer still on this client who opens
// such a project would otherwise see a project with no corrections, and the guard would pass every edit without a word. So a
// marker this client does not know is reported on every guard run, at the top of the brief and by doctor, and check and lint fail.
// No marker, or "chain", is the layout this client reads and changes nothing.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const READABLE_LAYOUTS = new Set(["chain"]);
export const layoutFile = (ledgerFile) => join(dirname(ledgerFile), "layout.json");

/** null when this client can read the ledger; otherwise { layout, file }. A marker that does not parse is not readable either. */
export function foreignLayout(ledgerFile) {
  const file = layoutFile(ledgerFile);
  if (!existsSync(file)) return null;
  let layout = null;
  try { const j = JSON.parse(readFileSync(file, "utf8")); layout = typeof j?.layout === "string" && j.layout ? j.layout : null; } catch { layout = null; }
  if (layout && READABLE_LAYOUTS.has(layout)) return null;
  return { layout: layout ?? "unknown", file };
}

export const UPGRADE = "npm i -g memory-pulse@latest, then memory-pulse install-hook";
export function layoutMessage(f, version) {
  return `memory-pulse ${version} cannot read this project's ledger: ${f.file} says layout "${f.layout}", which this client does not know. `
    + `Nothing in it is being enforced on this machine. Upgrade: ${UPGRADE}.`;
}
