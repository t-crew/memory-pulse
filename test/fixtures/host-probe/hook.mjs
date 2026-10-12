#!/usr/bin/env node
// Host probe (0.7.0 Task 1): injects one sentinel fact per hook event so a live run shows which injections reach the model.
// SessionStart uses plain stdout; UserPromptSubmit and PreToolUse use hookSpecificOutput.additionalContext with no permissionDecision.
let raw = ""; for await (const c of process.stdin) raw += c;
let ev = "unknown"; try { ev = JSON.parse(raw).hook_event_name ?? ev; } catch {}
const fact = `The project codename is PERIWINKLE-${ev}.`;
if (ev === "SessionStart") process.stdout.write(fact + "\n");
else process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: ev, additionalContext: fact } }));
