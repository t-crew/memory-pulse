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
Every append holds <ledger>.lock (created with O_EXCL; the same lock the npm client takes), re-reads the
file and computes t, prev and hash under it, so two writers in any language never share a t or a prev.

CLI:  python3 memory_pulse.py verify <ledger>   |   python3 memory_pulse.py append <ledger> <cause> <effect> [note]
      python3 memory_pulse.py board-post <board> <from> <to|all> <note|request|reply> <title> [body]   |   board-read <board> <agent>
      python3 memory_pulse.py board-reply <board> <t> <agent> <body>   |   board-ack <board> <t> <agent>      (Board: the shared agent message board)
      python3 memory_pulse.py board-verdict <board> <claim t> <agent> <upheld|refuted|withdrawn> [defect]   |   board-claims <board>
"""
from __future__ import annotations
import hashlib, json, os, sys, time, urllib.request

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

class LedgerLocked(RuntimeError): pass

def _pid_alive(pid) -> bool:
    if not isinstance(pid, int) or pid <= 0: return False
    try: os.kill(pid, 0); return True
    except ProcessLookupError: return False
    except PermissionError: return True

class _LedgerLock:
    """<ledger>.lock, the same protocol as server.mjs withLedgerLock: a dead holder or a lock older than 30 s is
    broken; a live one is waited for (MEMORY_PULSE_LOCK_TIMEOUT_MS, default 5000), then refused."""
    def __init__(self, path: str):
        self.lock = path + ".lock"
        self.timeout = int(os.environ.get("MEMORY_PULSE_LOCK_TIMEOUT_MS", "5000")) / 1000.0
    def __enter__(self):
        os.makedirs(os.path.dirname(os.path.abspath(self.lock)), exist_ok=True)
        deadline = time.time() + self.timeout
        while True:
            try:
                fd = os.open(self.lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
                with os.fdopen(fd, "w") as f: f.write(json.dumps({"pid": os.getpid(), "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}))
                return self
            except FileExistsError:
                holder, st = None, None
                try:
                    st = os.stat(self.lock)
                    with open(self.lock, encoding="utf-8") as f: holder = json.loads(f.read())
                except Exception: pass
                stale = st is not None and ((isinstance(holder, dict) and not _pid_alive(holder.get("pid"))) or time.time() - st.st_mtime > 30)
                if stale:
                    try:
                        if os.stat(self.lock).st_ino == st.st_ino: os.unlink(self.lock)
                    except FileNotFoundError: pass
                    continue
                if time.time() >= deadline: raise LedgerLocked(f"ledger is locked by pid {(holder or {}).get('pid', '?')} ({self.lock})")
                time.sleep(0.01)
    def __exit__(self, *exc):
        try: os.unlink(self.lock)
        except FileNotFoundError: pass

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
        with _LedgerLock(self.path): return self._append_locked(ev)

    def _append_locked(self, ev: dict) -> dict:
        # t, prev and hash are computed from the file as it stands under the lock
        events = self.events()
        ev["t"] = max([int(e.get("t") or 0) for e in events if isinstance(e.get("t"), int)] + [0]) + 1
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
        return {"written": True, "t": ev["t"], "stored": ev}

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

# ---- Agent message board (2026-10-16): the same board as lib/board.mjs, so a Python agent and a Node agent share one board file.
# Passive: posting runs nothing and wakes no one. A message is data, never an instruction: instruction-like text is stored, flagged
# (same patterns as server.mjs) and shown as data. The board is a ledger of its own (same chain and lock), never the project ledger.
import re as _re
_INSTRUCTION_PATTERNS = [
    ("protect-instructions", r"\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|all|earlier)\b[^.\n]{0,20}\b(instructions?|rules?|prompts?)\b"),
    ("protect-role", r"\byou are now\b|\bfrom now on,? you\b|\bact as (an?|the) (system|admin|developer)\b"),
    ("protect-boundaries", r"</?\s*[a-z][\w-]{2,40}\s*(?:[\s>]|$)|\[(system|assistant|tool)\s*:?\s*\]"),
    ("protect-configuration", r"\b(reveal|print|show|dump)\b[^.\n]{0,30}\b(system prompt|hidden prompt|your instructions)\b"),
    ("protect-execution", r"\b(run|execute|paste)\b[^.\n]{0,25}\b(this|the following)\b[^.\n]{0,15}\b(command|script|shell|code)\b"),
    ("protect-installs", r"\b(curl|wget)\b[^\n]{0,120}\|\s*(sudo\s+)?(sh|bash|zsh)\b"),
    ("protect-data", r"\b(rm\s+-rf\s+[/~]|drop\s+table|truncate\s+table|format\s+c:)"),
    ("protect-credentials", r"\b(send|post|upload|exfiltrat\w*|leak|forward|email)\b[^.\n]{0,40}\b(api[\s_-]?keys?|secrets?|tokens?|passwords?|credentials?)\b[^.\n]{0,40}\b(to|via|at)\b[^.\n]{0,4}(https?://|[\w.-]+@[\w.-]+\b|this\b|the following\b|that (address|url|endpoint|server)\b|me\b)|\b(send|give|show|tell) me\b[^.\n]{0,30}\b(api[\s_-]?keys?|secrets?|tokens?|passwords?|credentials?)\b"),
    ("protect-transparency", r"\b(do not|don't|never)\b[^.\n]{0,20}\b(tell|show|mention|reveal)\b[^.\n]{0,20}\b(the )?(user|human|operator)\b"),
]
_IPAT = [(i, _re.compile(p, _re.I)) for i, p in _INSTRUCTION_PATTERNS]
def instruction_like(text) -> list:
    if not isinstance(text, str) or not text: return []
    return [i for i, rx in _IPAT if rx.search(text)]

_BOARD_KINDS, _BOARD_ID = ("note", "request", "reply", "claim", "verdict", "synthesis"), _re.compile(r"^[a-z0-9][a-z0-9._-]{0,39}$")
_VERDICTS = ("upheld", "refuted", "withdrawn")
def _bslug(s): return (_re.sub(r"^-+|-+$", "", _re.sub(r"[^a-z0-9]+", "-", str(s).lower()))[:60]) or "message"
def _now_iso():
    import datetime; return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

class Board:
    """The shared agent message board (see lib/board.mjs): post / reply / ack / inbox / messages / verify."""
    def __init__(self, path: str): self.path = path; self.ledger = Ledger(path)

    def _load(self):
        msgs, acks = [], {}
        for r in self.ledger.events():
            b = r.get("board")
            if not isinstance(b, dict): continue
            if b.get("kind") == "ack": acks.setdefault(b.get("ack"), set()).add(b.get("from")); continue
            msgs.append({"t": r.get("t"), "from": b.get("from"), "to": b.get("to"), "kind": b.get("kind"), "title": b.get("title", r.get("effect")),
                         "body": r.get("note", ""), "at": b.get("at"), "thread": b.get("thread", r.get("t")), "reply_to": b.get("reply_to"),
                         "flagged": b.get("flagged", []), **({"verdict": b["verdict"], "defect": b.get("defect")} if b.get("verdict") else {}),
                         **({"over_open": b["over_open"]} if isinstance(b.get("over_open"), list) else {})})
        for m in msgs: m["acked_by"] = sorted(acks.get(m["t"], set()))
        return msgs

    def _write(self, ev):
        with _LedgerLock(self.path): return self.ledger._append_locked(ev)

    # Claims (see lib/board.mjs): open until another agent's verdict; a refutation names its defect; a synthesis is refused over an open claim.
    @staticmethod
    def _standing(c, msgs):
        vs = [v for v in msgs if v["kind"] == "verdict" and v["reply_to"] == c["t"]]
        if any(v.get("verdict") == "withdrawn" and v["from"] == c["from"] for v in vs): return "withdrawn", vs
        said = {v.get("verdict") for v in vs if v["from"] != c["from"]}
        return ("contested" if {"upheld", "refuted"} <= said else "refuted" if "refuted" in said else "upheld" if "upheld" in said else "open"), vs

    def claims(self, thread=None) -> list:
        msgs = self._load(); out = []
        for c in msgs:
            if c["kind"] != "claim" or (thread is not None and c["thread"] != int(thread)): continue
            st, vs = self._standing(c, msgs)
            out.append({"t": c["t"], "from": c["from"], "title": c["title"], "thread": c["thread"], "status": st,
                        "verdicts": [{"t": v["t"], "from": v["from"], "verdict": v.get("verdict"), "defect": v.get("defect"), "body": v["body"]} for v in vs]})
        return out

    def verdict(self, t, from_, verdict, defect="", body="") -> dict:
        return self.post(from_, "", "verdict", "", body, reply_to=t, verdict=verdict, defect=defect)

    def post(self, from_, to, kind="note", title="", body="", thread=None, reply_to=None, verdict=None, defect="", over_open=False) -> dict:
        from_, to, title, body = str(from_ or "").strip().lower(), str(to or "").strip().lower(), str(title or "").strip(), str(body or "")
        extra = {}
        if kind == "verdict":
            c = next((m for m in self._load() if m["t"] == int(reply_to or 0)), None)
            if not c or c["kind"] != "claim": return {"written": False, "reason": f"a verdict answers a claim: t{reply_to} is not a claim on this board"}
            if verdict not in _VERDICTS: return {"written": False, "reason": "the verdict is one of upheld, refuted, withdrawn"}
            if verdict == "withdrawn" and from_ != c["from"]: return {"written": False, "reason": f"only the claim's author ({c['from']}) withdraws it"}
            if verdict != "withdrawn" and from_ == c["from"]: return {"written": False, "reason": "an agent does not adjudicate its own claim; withdraw it instead"}
            defect = str(defect or "").strip()
            if verdict == "refuted" and len(defect.split()) < 3: return {"written": False, "reason": "a refutation names the defect: the step, number or fact in the claim that fails"}
            to = c["to"] if verdict == "withdrawn" else c["from"]; thread, reply_to = c["thread"], c["t"]; title = title or f"{verdict}: {c['title']}"[:200]
            extra = {"verdict": verdict, **({"defect": defect} if defect else {})}
        if kind in ("claim", "synthesis") and not to: to = "all"
        if kind == "synthesis":
            msgs = self._load()
            if not thread or not any(m["t"] == int(thread) for m in msgs): return {"written": False, "reason": "a synthesis names a thread on this board"}
            open_ = [m for m in msgs if m["kind"] == "claim" and m["thread"] == int(thread) and self._standing(m, msgs)[0] == "open"]
            if open_ and not over_open: return {"written": False, "reason": f"thread t{thread} has {len(open_)} open claim(s): " + ", ".join(f"t{m['t']} ({m['from']})" for m in open_)}
            if open_: extra["over_open"] = [m["t"] for m in open_]
        if not _BOARD_ID.match(from_): return {"written": False, "reason": "sender must be an agent id"}
        if to != "all" and not _BOARD_ID.match(to): return {"written": False, "reason": "addressee must be an agent id or 'all'"}
        if from_ == to: return {"written": False, "reason": "an agent does not post to itself"}
        if kind not in _BOARD_KINDS: return {"written": False, "reason": "kind must be note, request or reply"}
        if not title or len(title) > 200: return {"written": False, "reason": "title required, at most 200 characters"}
        if len(body) > 20000: return {"written": False, "reason": "body at most 20000 characters"}
        flagged = instruction_like(f"{title}\n{body}")
        bd = {"from": from_, "to": to, "kind": kind, "title": title, "at": _now_iso()}
        if thread: bd["thread"] = int(thread)
        if reply_to: bd["reply_to"] = int(reply_to)
        bd.update(extra)
        if flagged: bd["flagged"] = flagged
        ev = {"t": None, "cause": "board-post", "effect": _bslug(title), "kind": "event", **({"note": body} if body else {}), "tags": ["board", kind], "board": bd}
        r = self._write(ev); return {"written": True, "t": r["t"], "flagged": flagged, "board": self.path}

    def reply(self, t, from_, body="", title=None) -> dict:
        o = next((m for m in self._load() if m["t"] == int(t)), None)
        if not o: return {"written": False, "reason": f"no message t{t} on this board"}
        to = o["to"] if o["from"] == str(from_).lower() else o["from"]
        return self.post(from_, to, "reply", title or f"re: {o['title']}"[:200], body, thread=o["thread"], reply_to=o["t"])

    def ack(self, t, as_) -> dict:
        as_ = str(as_ or "").strip().lower(); m = next((x for x in self._load() if x["t"] == int(t)), None)
        if not m: return {"written": False, "reason": f"no message t{t} on this board"}
        if m["to"] not in (as_, "all"): return {"written": False, "reason": f"t{t} is addressed to {m['to']}, not {as_}"}
        ev = {"t": None, "cause": "board-ack", "effect": f"t{m['t']}", "kind": "event", "tags": ["board", "ack"], "board": {"from": as_, "kind": "ack", "ack": m["t"], "at": _now_iso()}}
        r = self._write(ev); return {"written": True, "t": r["t"]}

    def inbox(self, agent) -> list:
        a = str(agent or "").lower(); return [m for m in self._load() if m["to"] in (a, "all") and m["from"] != a and a not in m["acked_by"]]

    def messages(self) -> list: return self._load()
    def verify(self) -> dict: return self.ledger.verify()

if __name__ == "__main__":
    a = sys.argv[1:]
    if len(a) >= 2 and a[0] == "verify":
        v = Ledger(a[1]).verify(); print(json.dumps(v)); sys.exit(0 if v["ok"] else 2)
    if len(a) >= 4 and a[0] == "append":
        try: print(json.dumps(Ledger(a[1]).append(a[2], a[3], a[4] if len(a) > 4 else None))); sys.exit(0)
        except LedgerLocked as e: print(json.dumps({"written": False, "reason": str(e)})); sys.exit(1)
    if len(a) >= 5 and a[0] == "board-post":
        r = Board(a[1]).post(a[2], a[3], a[4], a[5] if len(a) > 5 else "", a[6] if len(a) > 6 else ""); print(json.dumps(r)); sys.exit(0 if r["written"] else 1)
    if len(a) >= 3 and a[0] == "board-read":
        B = Board(a[1]); print(json.dumps({"board": a[1], "integrity": B.verify(), "messages": B.inbox(a[2])}, ensure_ascii=False)); sys.exit(0)
    if len(a) >= 4 and a[0] == "board-ack":
        r = Board(a[1]).ack(a[2], a[3]); print(json.dumps(r)); sys.exit(0 if r["written"] else 1)
    if len(a) >= 5 and a[0] == "board-verdict":
        r = Board(a[1]).verdict(a[2], a[3], a[4], a[5] if len(a) > 5 else ""); print(json.dumps(r)); sys.exit(0 if r["written"] else 1)
    if len(a) >= 2 and a[0] == "board-claims":
        B = Board(a[1]); print(json.dumps({"board": a[1], "integrity": B.verify(), "claims": B.claims()}, ensure_ascii=False)); sys.exit(0)
    if len(a) >= 5 and a[0] == "board-reply":
        r = Board(a[1]).reply(a[2], a[3], a[4]); print(json.dumps(r)); sys.exit(0 if r["written"] else 1)
    print(__doc__); sys.exit(1)
