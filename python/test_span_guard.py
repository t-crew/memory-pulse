"""Tests for span_guard. Stdlib only, no model, no numpy:

    python3 -m unittest python/test_span_guard.py

Every decision is exercised with fake tokenizers. Two of them exist because
a real defect hid behind a single tokenizer: the whitespace one matches BPE
models where "$49" and "$29" share a leading id, and SpTok reproduces
SentencePiece, where encoding a bare fragment prepends a word-boundary piece.
"""
import os, sys, tempfile, unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from span_guard import SpanGuard          # noqa: E402
from memory_pulse import Ledger           # noqa: E402


class FakeTok:
    """Whitespace tokenizer; ids are stable within one instance."""
    def __init__(self):
        self.vocab, self.inv = {}, {}

    def encode(self, text, add_special_tokens=False):
        out = []
        for w in text.split():
            if w not in self.vocab:
                i = 1000 + len(self.vocab)
                self.vocab[w] = i
                self.inv[i] = w
            out.append(self.vocab[w])
        return out

    def decode(self, ids):
        return " ".join(self.inv.get(int(i), "") for i in ids)


class SpTok:
    """SentencePiece-shaped: encode("29") == [BOUND, 2, 9], and BOUND decodes
    to a space. Measured on TinyLlama, where 29871 is that piece."""
    BOUND, DOLLAR = 1, 2
    DIGIT = {str(d): 10 + d for d in range(10)}

    def __init__(self):
        self.inv = {self.BOUND: " ", self.DOLLAR: "$"}
        self.inv.update({v: k for k, v in self.DIGIT.items()})

    def encode(self, text, add_special_tokens=False):
        body = text[1:] if text.startswith(" ") else text
        out = [self.BOUND]
        for ch in body:
            if ch == "$":
                out.append(self.DOLLAR)
            elif ch in self.DIGIT:
                out.append(self.DIGIT[ch])
        if len(out) > 1 and out[1] == self.DOLLAR:   # "▁$" merges
            out = out[1:]
        return out

    def decode(self, ids):
        return "".join(self.inv.get(int(i), "") for i in ids)


class Arr:
    """Just enough array for the logits adapter, so numpy is not required."""
    def __init__(self, v, dtype="float32"):
        self.v, self.dtype = list(v), dtype

    @property
    def shape(self):
        return (len(self.v),)

    def astype(self, dt):
        return Arr(self.v, dt)

    def __add__(self, o):
        return Arr([a + b for a, b in zip(self.v, o.v)], self.dtype)

    def __getitem__(self, i):
        return self.v[i]

    def __setitem__(self, i, x):
        self.v[i] = x

    def __iter__(self):
        return iter(self.v)


class FakeNp:
    float32 = "float32"
    array = staticmethod(lambda x: Arr(x))
    zeros = staticmethod(lambda n, dtype=None: Arr([0.0] * n, dtype))


class FakeMx:
    array = staticmethod(lambda a: Arr(list(a)))


def guard(tok, withdrawn, replacement=(), variants=(), window=24):
    return SpanGuard.from_terms(tok, withdrawn, replacement, variants=variants, window=window)


class Decision(unittest.TestCase):
    def setUp(self):
        self.tok = FakeTok()

    def test_a_single_token_value_is_always_banned(self):
        g = guard(self.tok, ["$49"])
        self.assertIn(self.tok.vocab["$49"], g.banned([]))

    def test_a_multi_token_value_is_banned_at_its_completing_token(self):
        g = guard(self.tok, ["Postgres 14"])
        pg, v14 = self.tok.vocab["Postgres"], self.tok.vocab["14"]
        self.assertNotIn(pg, g.banned([]), "the first token is ordinary text")
        self.assertIn(v14, g.banned([pg]), "the completion is not")

    def test_a_diverged_prefix_releases_the_ban(self):
        g = guard(self.tok, ["Postgres 14"])
        ids = self.tok.encode("Postgres 16 and")
        self.assertNotIn(self.tok.vocab["14"], g.banned(ids))

    def test_the_replacement_nearby_permits_a_comparison(self):
        g = guard(self.tok, ["$49"], ["$29"], window=8)
        near = self.tok.encode("was $49 now $29 per seat")
        self.assertNotIn(self.tok.vocab["$49"], g.banned(near))

    def test_disavowal_is_local_not_bought_once_at_the_top(self):
        g = guard(self.tok, ["$49"], ["$29"], window=4)
        far = self.tok.encode("$29 " + "filler " * 10)
        self.assertIn(self.tok.vocab["$49"], g.banned(far),
                      "a replacement outside the window does not switch the guard off")

    def test_written_variants_are_blocked_too(self):
        g = guard(self.tok, ["$49"], ["$29"], variants=["forty-nine dollars"])
        self.assertIn(self.tok.vocab["dollars"], g.banned([self.tok.vocab["forty-nine"]]))

    def test_the_offer_is_the_replacements_continuation(self):
        g = guard(self.tok, ["Postgres 14"], ["Postgres 16"])
        pg = self.tok.vocab["Postgres"]
        self.assertEqual(g.offer([pg]), [self.tok.vocab["16"]],
                         "never the word the model just wrote")

    def test_every_ban_names_the_correction(self):
        g = SpanGuard.from_corrections(self.tok, [{"withdrawn": ["$49"], "replacement": ["$29"], "t": 7}])
        why = g.why([])
        self.assertEqual(why[0]["t"], 7)
        self.assertEqual(why[0]["replacement"], ["$29"])

    def test_no_corrections_means_no_bans(self):
        self.assertEqual(SpanGuard.from_corrections(self.tok, []).banned(self.tok.encode("$49")), set())


class SentencePiece(unittest.TestCase):
    def test_the_offer_is_never_the_word_boundary_piece(self):
        """MEASURED on TinyLlama-1.1B: with the boundary piece offered, the
        model wrote "$  $  $  $  $  $". Qwen was unaffected."""
        tok = SpTok()
        self.assertEqual(tok.encode("29")[0], SpTok.BOUND, "the fake reproduces the defect")
        g = guard(tok, ["$49"], ["$29"])
        hist = tok.encode("$")
        self.assertIn(tok.DIGIT["4"], g.banned(hist))
        offers = g.offer(hist)
        self.assertEqual(offers, [tok.DIGIT["2"]])

    def test_no_shared_prefix_still_offers_a_visible_token(self):
        tok = SpTok()
        g = guard(tok, ["$49"], ["70"])
        for o in g.offer(tok.encode("$")):
            self.assertTrue(tok.decode([o]).strip(), "offered whitespace")


class FromLedger(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="mp-span-")
        self.L = Ledger(os.path.join(self.dir, "events.jsonl"))
        self.tok = FakeTok()

    def test_it_builds_from_ledger_rows_and_enforces_them(self):
        self.L.append("price-launched", "price-corrected", kind="correction",
                      withdrawn=["$49"], replacement=["$29"])
        g = SpanGuard.from_ledger(self.tok, self.L)
        self.assertIn(self.tok.vocab["$49"], g.banned([]))
        self.assertEqual(g.why([])[0]["t"], 1)

    def test_a_superseded_correction_is_not_enforced(self):
        self.L.append("a", "b", kind="correction", withdrawn=["$49"], replacement=["$39"])
        self.L.append("b", "c", kind="correction", withdrawn=["$39"], replacement=["$29"], supersedes=[1])
        g = SpanGuard.from_ledger(self.tok, self.L)
        self.tok.encode("$49")                      # give the retired term an id to look for
        self.assertNotIn(self.tok.vocab["$49"], g.banned([]), "row 1 was retired by row 2")
        self.assertIn(self.tok.vocab["$39"], g.banned([]))

    def test_a_broken_chain_fails_closed(self):
        self.L.append("a", "b", kind="correction", withdrawn=["$49"], replacement=["$29"], note="original")
        path = self.L.path
        with open(path, encoding="utf-8") as f:
            raw = f.read()
        with open(path, "w", encoding="utf-8") as f:
            f.write(raw.replace("original", "REWRITTEN"))
        with self.assertRaises(ValueError):
            SpanGuard.from_ledger(self.tok, self.L)


class Adapter(unittest.TestCase):
    def test_the_processor_masks_the_ban_and_makes_the_offer_win(self):
        tok = FakeTok()
        g = guard(tok, ["Postgres 14"], ["Postgres 16"])
        pg, v14, v16 = tok.vocab["Postgres"], tok.vocab["14"], tok.vocab["16"]
        proc = g.logits_processor(FakeMx, FakeNp)
        n = max(pg, v14, v16) + 3
        out = proc([pg], Arr([0.0] * n))
        vals = list(out)
        self.assertEqual(vals.index(min(vals)), v14)
        self.assertEqual(vals.index(max(vals)), v16)
        self.assertTrue(all(abs(x) < 70000 for x in vals), "stays finite in float16")

    def test_the_processor_is_a_no_op_when_nothing_fires(self):
        tok = FakeTok()
        g = guard(tok, ["Postgres 14"], ["Postgres 16"])
        logits = Arr([0.0] * 1100)
        self.assertIs(g.logits_processor(FakeMx, FakeNp)([tok.vocab["hello"] if "hello" in tok.vocab else 1050], logits), logits)


if __name__ == "__main__":
    unittest.main(verbosity=1)
