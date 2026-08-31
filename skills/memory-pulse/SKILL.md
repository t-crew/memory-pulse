---
name: memory-pulse
description: Use the memory-pulse tools well — re-enter a project through its ledger before answering about prior work, record decisions and corrections so the guard can enforce them, and recall before re-deriving. Load whenever a project has a .memory-pulse/ ledger, or when the user asks to remember, correct, or recall something about the project.
---

# memory-pulse — how to use project memory well

The ledger is a file in this repo (`.memory-pulse/events.jsonl`). It records
what happened and why, as cause → effect links. Corrections are special: a
recorded correction always surfaces first, and the guard hook blocks any edit
that writes a withdrawn value back.

## 1. Re-enter before you answer

Before answering anything about prior work, decisions, numbers, or history in
this project, call `pulse` (tier `brief`). If a SessionStart hook is
installed, the brief is already in your context — read its CORRECTIONS block
first and treat every entry there as binding.

Do not re-derive something the ledger already settled. If a question is about
a specific entity, call `recall` with `op: "effects"` or `op: "causes"` on it
before reasoning from scratch.

## 2. Record what changes the project's state

Call `remember` when something happened that a future session must know:
a decision, a measurement, a shipped change, a dead end. One event per fact.

- `cause` and `effect` are short, stable slugs (`pricing-page-shipped`,
  `p95-latency-measured`). Reuse existing slugs; check with `recall` if unsure.
- `note` says what was measured and how — numbers with their method.

## 3. Corrections are the point — record them with withdrawn terms

When a number, name, or claim is withdrawn, call `remember` with
`kind: "correction"` AND `withdrawn: [...]` listing the exact strings that
must never be written again:

```
remember({
  cause: "pricing-page-shipped",
  effect: "price-corrected-to-29",
  kind: "correction",
  note: "$49 came from a comp analysis; measured willingness to pay is $29",
  withdrawn: ["$49", "49/seat"]
})
```

A correction without `withdrawn` terms still surfaces first, but cannot be
enforced by the guard. Prefer exact tokens (`"1480 rps"`, `"n=14"`) over
prose.

## 4. Respect the guard

If an Edit or Write is blocked with "memory-pulse guard: this edit
reintroduces a withdrawn value", do not retry the same text. Use the
corrected value from the cited ledger line. If you believe the correction
itself is wrong, record a new correction explaining why — never bypass.

## 5. Use `execute` for cross-referencing, not `pulse`

Questions that need a computation over many events ("which corrections touch
the billing path?") go to `execute`: write a small async program against
`ctx.memory.effects/causes/pulse/when` and return only the answer. The corpus
it reads never enters your context.

## 6. What not to do

- Do not paste the ledger file into context. Pulse it.
- Do not record secrets, credentials, or personal data in notes.
- Do not invent slugs for entities that already exist — recall first.
- Do not quote a number from history if the CORRECTIONS block withdrew it.
