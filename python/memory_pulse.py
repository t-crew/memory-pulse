"""memory_pulse — stdlib-only Python client for the memory-pulse ledger.

Same file format, same hash chain, same guard rule as the npm client (server.mjs), so a Python
agent (LangChain, CrewAI, AutoGen, your own loop) and a Claude Code / Codex session can share one
ledger and verify each other's rows.

    from memory_pulse import Ledger
    L = Ledger(".memory-pulse/events.jsonl")
    L.append("pricing-corrected", "price-is-29", kind="correction", withdrawn=["$49"], replacement=["$29"])
    L.verify()                     # {"ok": True, "chained": 1, "legacy": 0, "unsealed": 0, ...}
    L.check("the price is $49")    # {"verdict": "blocked", "reasons": [...]}
    L.brief(key="mp_live_...")     # the engine's corrections-first brief (network)

Chain rules (identical to server.mjs):
  hash        = sha256(canonical JSON of the row without `hash`)  — keys sorted, no spaces
  prev        = hash of the previous chained row (None on the first chained row)
  legacy_digest (first chained row) / gap_digest (later rows) = sha256 of the raw unchained lines
                since the previous chained row, trimmed, joined by "\n"
Rows are never edited. Corrections are appended.

CLI:  python3 memory_pulse.py verify <ledger>   |   python3 memory_pulse.py append <ledger> <cause> <effect> [note]
"""
from __future__ import annotations
import hashlib, json, os, sys, urllib.request

def canonical_json(v) -> str:
    """JSON.stringify with sorted keys and no whitespace; integral floats print like JS (1.0 -> 1)."""
    if v is None or isinstance(v, (bool, str)):
        return json.dumps(v, ensure_ascii=False, separators=(",", ":"))
    if isinstance(v, float):
        if v != v or v in (float("inf"), float("-inf")): raise ValueError("canonical JSON requires finite numbers")
        return str(int(v)) if v.is_integer() else json.dumps(v)
    if isinstance(v, int):
        return str(v)
    if isinstance(v, (list, tuple)):
        return "[" + ",".join(canonical_json(x) for x in v) + "]"
    if isinstance(v, dict):
        return "{" + ",".join(json.dumps(k, ensure_ascii=False, separators=(",", ":")) + ":" + canonical_json(v[k]) for k in sorted(v)) + "}"
    raise TypeError("canonical JSON supports only JSON values")

def _sha(s: str) -> str: return hashlib.sha256(s.encode("utf-8")).hexdigest()
def row_hash(row: dict) -> str: return _sha(canonical_json({k: v for k, v in row.items() if k != "hash"}))
def seal_digest(lines) -> str: return _sha("\n".join(l.strip() for l in lines if l.strip()))
def _has_hash(line: str) -> bool:
    try: o = json.loads(line); return isinstance(o, dict) and isinstance(o.get("hash"), str)
    except Exception: return False

def verify_lines(lines) -> dict:
    lines = [l for l in lines if l.strip()]
    prev, chained, frm, legacy, gap = None, 0, None, 0, []
    def out(**extra): return {"legacy": legacy, "chained": chained, "head": prev, "from": frm, **extra}
    for i, line in enumerate(lines):
        if not _has_hash(line): gap.append(line); continue
        row = json.loads(line)
        if chained == 0:
            frm, legacy = row.get("t"), len(gap)
            if row.get("legacy_digest") != seal_digest(gap): return out(ok=False, head=None, reason=f"legacy rows changed since the chain sealed them (digest mismatch at t={row.get('t')})", brokenAt=row.get("t"))
        else:
            if row.get("prev") != prev: return out(ok=False, reason=f"row t={row.get('t')} does not link to the previous chained row (a row was removed, reordered or inserted)", brokenAt=row.get("t"))
            want = row.get("gap_digest")
            if (want is None and gap) or (want is not None and want != seal_digest(gap)): return out(ok=False, reason=f"unchained rows before t={row.get('t')} do not match the gap it sealed ({len(gap)} row(s); edited, removed or inserted)", brokenAt=row.get("t"))
        if row_hash(row) != row["hash"]: return out(ok=False, reason=f"row t={row.get('t')} does not match its own hash (edited in place)", brokenAt=row.get("t"))
        prev, chained, gap = row["hash"], chained + 1, []
    if chained == 0: return {"ok": True, "legacy": len(gap), "chained": 0, "head": None, "from": None, "sealed": False, "unsealed": 0}
    return out(ok=True, sealed=True, unsealed=len(gap))

class Ledger:
    def __init__(self, path: str, api: str = "https://pulse.strategic-innovations.ai"):
        self.path, self.api = path, api.rstrip("/")

    def _lines(self):
        if not os.path.exists(self.path): return []
        with open(self.path, encoding="utf-8") as f: return f.read().split("\n")

    def events(self):
        out = []
        for l in self._lines():
            if not l.strip(): continue
            try:
                e = json.loads(l)
                if isinstance(e.get("cause"), str) and isinstance(e.get("effect"), str): out.append(e)
            except Exception: pass
        return out

    def verify(self) -> dict: return verify_lines(self._lines())

    def append(self, cause: str, effect: str, note: str | None = None, kind: str = "event", tags=None, withdrawn=None, replacement=None, supersedes=None, pinned: bool = False) -> dict:
        if not cause or not effect: raise ValueError("cause and effect are required")
        events = self.events()
        for e in events:
            if e["cause"] == cause and e["effect"] == effect and (e.get("note") or "") == (note or ""): return {"written": False, "reason": "duplicate", "t": e.get("t")}
        t = max([int(e.get("t") or 0) for e in events] + [0]) + 1
        ev = {"t": t, "cause": cause, "effect": effect, "kind": kind or "event"}
        if note: ev["note"] = note
        if tags: ev["tags"] = list(tags)
        if pinned: ev["pinned"] = True
        w = [str(x).strip() for x in (withdrawn or []) if len(str(x).strip()) >= 2]
        r = [str(x).strip() for x in (replacement or []) if len(str(x).strip()) >= 1]
        if w: ev["withdrawn"] = w
        if r: ev["replacement"] = r
        if supersedes: ev["supersedes"] = sorted(set(int(x) for x in supersedes))
        if (w or supersedes) and ev["kind"] != "correction": raise ValueError("withdrawn/supersedes only belong on a correction")
        # chain
        raw = [l for l in self._lines() if l.strip()]
        last, seen, gap = None, False, []
        for l in raw:
            if _has_hash(l): seen, last, gap = True, json.loads(l)["hash"], []
            else: gap.append(l)
        if seen:
            ev["prev"] = last
            if gap: ev["gap_digest"] = seal_digest(gap)
        else:
            ev["legacy_digest"] = seal_digest(gap); ev["prev"] = None
        ev["hash"] = row_hash(ev)
        os.makedirs(os.path.dirname(os.path.abspath(self.path)), exist_ok=True)
        with open(self.path, "a", encoding="utf-8") as f: f.write(json.dumps(ev, ensure_ascii=False, separators=(",", ":")) + "\n")
        return {"written": True, "t": t, "stored": ev}

    def check(self, text: str) -> dict:
        """The guard's core rule, locally: a withdrawn term present without its replacement is blocked."""
        chain = self.verify()
        if not chain.get("ok"):
            return {"verdict": "blocked", "reasons": [f"ledger chain broken: {chain.get('reason')} — a memory whose own history is in question cannot vouch for anything"]}
        retired = set()
        for e in self.events():
            if e.get("kind") == "correction": retired.update(e.get("supersedes") or [])
        reasons, hits = [], []
        for c in self.events():
            if c.get("kind") != "correction" or not c.get("withdrawn") or c.get("t") in retired: continue
            disavowed = any(r and r in text for r in (c.get("replacement") or []))
            for term in c["withdrawn"]:
                if not term or term not in text: continue
                if disavowed: reasons.append(f'"{term}" appears beside its replacement (comparison or disavowal) — allowed, per ledger t{c.get("t")}'); continue
                hits.append(term); reasons.append(f'"{term}" was withdrawn at t{c.get("t")} ({c["cause"]} -> {c["effect"]}); use {", ".join(c.get("replacement") or ["the corrected value"])}')
        if hits: return {"verdict": "blocked", "reasons": reasons}
        return {"verdict": "verified" if reasons else "no_evidence", "reasons": reasons or ["no recorded correction bears on this text"]}

    def pulse(self, key: str | None = None, tier: str = "brief", route: str = "/v1/pulse", **body) -> dict:
        data = json.dumps({"events": self.events(), "tier": tier, **body}).encode("utf-8")
        req = urllib.request.Request(self.api + route, data=data, headers={"content-type": "application/json", **({"x-mp-key": key} if key else {})})
        with urllib.request.urlopen(req, timeout=30) as r: return json.loads(r.read().decode("utf-8"))

    def brief(self, key: str | None = None) -> str:
        out = self.pulse(key=key); return out.get("text") or json.dumps(out)

if __name__ == "__main__":
    a = sys.argv[1:]
    if len(a) >= 2 and a[0] == "verify":
        v = Ledger(a[1]).verify(); print(json.dumps(v)); sys.exit(0 if v["ok"] else 2)
    if len(a) >= 4 and a[0] == "append":
        print(json.dumps(Ledger(a[1]).append(a[2], a[3], a[4] if len(a) > 4 else None))); sys.exit(0)
    print(__doc__); sys.exit(1)
