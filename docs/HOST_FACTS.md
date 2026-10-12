# Host facts: which hook injections reach the model

Measured 2026-10-12 with `test/fixtures/host-probe/probe.sh`. Each hook injects one sentinel fact, "The project codename is PERIWINKLE-<event>", and the model is then asked to list every codename it was told. One run per host; re-run the probe after a host upgrade.

| Injection | Claude Code 2.1.296 | Codex CLI 0.160.0 |
|---|---|---|
| SessionStart, plain stdout | reaches the model | reaches the model |
| UserPromptSubmit, `hookSpecificOutput.additionalContext` | reaches the model | reaches the model |
| PreToolUse, `hookSpecificOutput.additionalContext`, no `permissionDecision` | reaches the model | hook runs, the fact did not reach the model (n=1) |

What follows for memory-pulse:

- **Session start and per-prompt memory work on both hosts.**
- **Per-edit memory works on Claude Code only.** On Codex the guard still blocks (exit 2). The per-edit slice is emitted but has no effect there.
- **Size cap.** Claude Code caps a hook's injected text at 10,000 characters. Over the cap, the text is saved to a file and the model sees only a 2,000-character preview. The probe showed this happening to a 16,933-character session brief: the model reported that "the longer startup hook output was cut short". Every memory-pulse injection must stay under 10,000 characters. The scaffold's default total is 6,200.
- **Never `"allow"`.** A PreToolUse hook must never send `permissionDecision: "allow"`, because that skips the user's permission prompt. memory-pulse sends only `additionalContext`.

Sources: https://code.claude.com/docs/en/hooks.md (read 2026-10-12) and https://learn.chatgpt.com/docs/hooks.
