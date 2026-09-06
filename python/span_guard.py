"""span_guard — decode-time correction enforcement for local models.

The PreToolUse guard blocks an EDIT that writes a withdrawn value back. This
is the same rule one layer down, for a model you run yourself: the token that
would complete a withdrawn value is masked at decode time, so the value cannot
be generated at all, and the replacement is offered in its place.

    from memory_pulse import Ledger
    from span_guard import SpanGuard
    guard = SpanGuard.from_ledger(tok, Ledger(".memory-pulse/events.jsonl"))
    # mlx-lm:  generate_step(..., logits_processors=[guard.logits_processor(mx, np)])
    # any runtime: guard.banned(ids_so_far) -> ids to mask; guard.offer(ids_so_far) -> ids to prefer

Stdlib only. Nothing here imports a model runtime; the adapter takes `mx` and
`np` as arguments. The decision is pure and tested without a model in
test_span_guard.py, so a tokenizer difference shows up in milliseconds.

THE CLAIM. A value the ledger retired cannot complete in the token stream.
Not discouraged, not reminded about: unable to win the argmax, because the
token that would finish it carries a large negative logit.

WHY A MASK AND NOT A PROMPT. Prompted bans prime the ban and account for the
large majority of failures; a hard mask gives zero surface violations because
the model is not being asked, it is being constrained. Telling a model not to
say something is the least reliable way to stop it.

THE UNIT IS PURE. Everything here decides, from the ids generated so far,
which ids must not be allowed next. No model, no mlx, no tokenizer beyond an
`encode`. That makes the hard part testable in milliseconds and keeps the
runtime adapter thin enough to read in one sitting.

THREE DEFECTS IN THE FIRST IMPLEMENTATION THIS FIXES, all measured:

  disavowal was computed once, from the prompt only. So a prompt that happened
  to name the replacement switched the guard off for the entire generation
  ("a prompt naming the replacement may still cite the old value"), and a
  model that named the replacement itself mid-sentence stayed blocked. Here
  disavowal is read from the live history and scoped to a window, so it is
  earned locally and cannot be bought once at the top.

  the first token of a multi-token span was never banned, which is correct,
  but nothing checked that the span could still complete after the prefix
  diverged — the ban is now released the moment the continuation is broken.

  only the literal spelling was blocked. Blocking "$49" while "forty-nine
  dollars" sails past is a token ban wearing a better name, so a term carries
  its written variants and every one of them is blocked.

WHAT IT STILL CANNOT DO. It blocks the spellings it was given. A paraphrase
nobody enumerated gets through, which is exactly the leakage the corrections
bench measures rather than hides.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Sequence, Set

DEFAULT_WINDOW = 24


def _encode(tok, text: str) -> List[int]:
    try:
        return [int(t) for t in tok.encode(text, add_special_tokens=False)]
    except TypeError:                       # tokenizers without the kwarg
        return [int(t) for t in tok.encode(text)]


@dataclass
class _Span:
    """One spelling of one withdrawn value, as token ids."""
    ids: List[int]
    term: str
    correction: int


@dataclass
class _Rule:
    """One correction: every spelling it retires, and what replaces it."""
    spans: List[_Span] = field(default_factory=list)
    replacement_ids: List[List[int]] = field(default_factory=list)
    replacement_terms: List[str] = field(default_factory=list)
    offer_ids: List[int] = field(default_factory=list)
    t: Any = None


class SpanGuard:
    def __init__(self, rules: Sequence[_Rule], window: int = DEFAULT_WINDOW, tok=None):
        self.rules = list(rules)
        self.window = int(window)
        self.tok = tok

    # ── construction ──────────────────────────────────────────────
    @classmethod
    def from_terms(cls, tok, withdrawn, replacement=(), variants=(), window=DEFAULT_WINDOW, t=None):
        return cls.from_corrections(
            tok,
            [{"withdrawn": list(withdrawn), "replacement": list(replacement),
              "variants": list(variants), "t": t}],
            window=window,
        )

    @classmethod
    def from_corrections(cls, tok, corrections: Iterable[Dict[str, Any]], window=DEFAULT_WINDOW):
        """`corrections` are ledger rows: {withdrawn, replacement, variants?, t?}.

        Each term is encoded bare and with a leading space, because most
        tokenizers give a word a different id depending on whether it opens a
        line. Missing that is how a guard passes its tests and fails live.
        """
        rules: List[_Rule] = []
        for i, c in enumerate(corrections or []):
            withdrawn = [w for w in (c.get("withdrawn") or []) if w]
            if not withdrawn:
                continue
            replacement = [r for r in (c.get("replacement") or []) if r]
            spellings = list(withdrawn) + [v for v in (c.get("variants") or []) if v]
            spans: List[_Span] = []
            for term in spellings:
                for form in (term, " " + term):
                    ids = _encode(tok, form)
                    if ids and not any(s.ids == ids for s in spans):
                        spans.append(_Span(ids, term, i))
            rule = _Rule(
                spans=spans,
                replacement_ids=[_encode(tok, r) for r in replacement]
                + [_encode(tok, " " + r) for r in replacement],
                replacement_terms=replacement,
                offer_ids=_encode(tok, replacement[0]) if replacement else [],
                t=c.get("t", i),
            )
            rules.append(rule)
        return cls(rules, window=window, tok=tok)

    @classmethod
    def from_ledger(cls, tok, ledger, window=DEFAULT_WINDOW):
        """Build from a memory_pulse.Ledger, under the rules Ledger.check() uses.

        The chain is verified first and a broken chain raises, because a memory
        whose own history is in question cannot vouch for anything. A
        correction that `supersedes` earlier rows retires them, so only the
        latest binding correction is enforced.
        """
        chain = ledger.verify()
        if not chain.get("ok"):
            raise ValueError(f"ledger chain broken: {chain.get('reason')}")
        events = ledger.events()
        retired = set()
        for e in events:
            if e.get("kind") == "correction":
                retired.update(e.get("supersedes") or [])
        rows = [e for e in events
                if e.get("kind") == "correction" and e.get("withdrawn") and e.get("t") not in retired]
        return cls.from_corrections(tok, rows, window=window)

    # ── the decision ──────────────────────────────────────────────
    def _disavowed(self, history: Sequence[int], rule: _Rule) -> bool:
        """Is the replacement present nearby? Naming both values is a
        comparison, and comparisons are how a correction gets explained.
        Scoped to a window so it is earned locally rather than once."""
        if not rule.replacement_ids:
            return False
        tail = list(history)[-self.window:] if self.window else list(history)
        n = len(tail)
        for ids in rule.replacement_ids:
            if not ids:
                continue
            L = len(ids)
            for s in range(n - L + 1):
                if tail[s:s + L] == ids:
                    return True
        return False

    def _fired(self, history: Sequence[int]):
        """(token id, span) pairs that must not be allowed next."""
        hist = list(history)
        out = []
        for rule in self.rules:
            if self._disavowed(hist, rule):
                continue
            for span in rule.spans:
                ids = span.ids
                if len(ids) == 1:
                    out.append((ids[0], span, rule))
                    continue
                # ban the continuation only while the prefix is still intact;
                # the longest matching prefix decides which token completes it
                for L in range(len(ids) - 1, 0, -1):
                    if len(hist) >= L and hist[-L:] == ids[:L]:
                        out.append((ids[L], span, rule))
                        break
        return out

    def banned(self, history: Sequence[int]) -> Set[int]:
        return {tid for tid, _, _ in self._fired(history)}

    def _first_visible(self, ids: Sequence[int]):
        """The first id that actually writes a character.

        A tokenizer's word-boundary piece decodes to nothing visible, so
        offering it hands the model a space where the corrected value should
        be. Every path that picks an id to offer goes through here.
        """
        if not ids:
            return None
        if self.tok is None:
            return ids[0]
        for i in ids:
            try:
                if str(self.tok.decode([int(i)])).strip():
                    return int(i)
            except Exception:
                return int(i)
        return None

    def _aligned_offer(self, hist: List[int], span: _Span, rule: _Rule):
        """The replacement's continuation given what is already written.

        TWO ALIGNMENTS, and the order matters — both were found live.

        ID-LEVEL FIRST. A withdrawn value and its replacement usually share a
        leading token ("$49" and "$29" both start with "$"), so once that
        token is emitted the next id of the replacement is the answer, exactly.

        TEXT-LEVEL SECOND, for tokenizers where the two do not share ids.
        Re-encoding the remainder is the fallback, and it must strip a leading
        word-boundary token: MEASURED on TinyLlama, encode("29") returns
        [29871, 29906, 29929] where 29871 is SentencePiece's space marker, so
        the guard offered whitespace and the model emitted "$  $  $  $  $  $".
        """
        ids = rule.offer_ids
        if not ids:
            return None
        # 1. the replacement's own ids already continue what was emitted
        for L in range(min(len(ids) - 1, len(hist)), 0, -1):
            if hist[-L:] == ids[:L]:
                return ids[L]
        # 2. fall back to matching on decoded text
        if rule.replacement_terms and self.tok is not None:
            rep = rule.replacement_terms[0]
            for L in range(min(len(span.ids) - 1, len(hist)), 0, -1):
                if hist[-L:] != span.ids[:L]:
                    continue
                try:
                    emitted = str(self.tok.decode(span.ids[:L])).lstrip()
                except Exception:
                    break
                if emitted and rep.startswith(emitted):
                    rest = rep[len(emitted):]
                    if not rest:
                        return None
                    vis = self._first_visible(_encode(self.tok, rest))
                    if vis is not None:
                        return vis
                break
        return self._first_visible(ids)

    def offer(self, history: Sequence[int]) -> List[int]:
        """The replacement's NEXT token, aligned to what has already been
        emitted. When a withdrawn value and its replacement share a prefix
        ("Postgres 14" -> "Postgres 16") the model has usually already written
        that prefix by the time the ban fires, so offering the replacement's
        first token would hand it a word it just wrote. Offer the
        continuation instead: the token after the longest prefix of the
        replacement that the history already ends with."""
        hist = list(history)
        seen, out = set(), []
        for _, span, rule in self._fired(hist):
            nxt = self._aligned_offer(hist, span, rule)
            if nxt is None or nxt in seen:
                continue
            seen.add(nxt)
            out.append(nxt)
        return out

    def why(self, history: Sequence[int]) -> List[Dict[str, Any]]:
        """Every ban names the correction that caused it. A block a user
        cannot trace is a block they cannot trust."""
        out, seen = [], set()
        for tid, span, rule in self._fired(history):
            key = (tid, span.term)
            if key in seen:
                continue
            seen.add(key)
            out.append({"token": tid, "term": span.term, "t": rule.t,
                        "replacement": list(rule.replacement_terms)})
        return out

    # ── runtime adapter ───────────────────────────────────────────
    def logits_processor(self, mx, np, block: float = -3e4, force: bool = True,
                         boost: float = 8.0):
        """An mlx-lm logits processor. Thin on purpose: every decision above
        is already made and tested without a model.

        A CORRECTION TO MY OWN NOTE HERE, 2026-09-04. This docstring used to
        say `force` existed because a +8 boost was too weak — that TinyLlama
        degenerated to "$  $  $  $  $  $" because the encouraged replacement
        could not outrank another "$". That was wrong, and it was the exact
        failure this module is built to prevent: a claim that outran its
        measurement. The real cause was `_aligned_offer` returning
        SentencePiece's word-boundary token, so the guard was boosting a
        SPACE. Once the offer names a visible token, MEASURED on both
        TinyLlama-1.1B and Qwen2.5-1.5B, force=False produces the corrected
        value on its own.

        So `force` is a policy choice, not a repair. The ledger already
        records what the value is, so once the model is demonstrably mid-way
        through writing a retired one the continuation is not a preference to
        be outranked by sampling noise. Keep it on when the guarantee matters,
        turn it off when the model should stay free to phrase the sentence its
        own way. With no replacement recorded there is nothing to force.
        """
        def proc(tokens, logits):
            hist = [int(t) for t in np.array(tokens)]
            ban = self.banned(hist)
            if not ban:
                return logits
            add = np.zeros(logits.shape[-1], dtype=np.float32)
            for b in ban:
                add[b] = block
            offers = [o for o in self.offer(hist) if o not in ban]
            if offers:
                if force:
                    # A large additive constant, not a computed offset: reading
                    # the logits back would mean converting an mlx bfloat16
                    # array to numpy, which raises.
                    #
                    # MEASURED: 1e6 OVERFLOWS float16, whose maximum is 65504,
                    # so the offered logit became +inf, the argmax went
                    # degenerate and Qwen emitted "$!". The constant must be
                    # large enough to win and small enough to stay finite in
                    # the model's own dtype. Raw logits sit well under 100, so
                    # 3e4 wins outright and survives float16.
                    for o in offers:
                        add[o] = 3e4
                else:
                    for o in offers:
                        add[o] += boost
            return logits + mx.array(add).astype(logits.dtype)
        return proc
