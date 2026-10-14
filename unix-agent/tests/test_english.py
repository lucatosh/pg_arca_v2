"""The agent's messages reach the console's (English) interface: no Italian left in its string literals."""
import io
import os
import re
import tokenize
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IT = re.compile(r"[àèéìòù]|\b(della|delle|degli|dello|nella|nelle|questo|questa|quando|perché|sono|vengono|viene|cartella|cartelle|ripristino|ripristina|"
                r"nessun|nessuna|impostazioni|errore|fallita|completato|utente|nodo|nodi|primario|sito|siti|ruolo|ruoli|righe|tabelle|sola|lettura|"
                r"operatore|macchin\w*|operativ\w*|valori|predefinit\w*|vedi|ultimo|ultima|giorni|obiettivo|diverso|anche|ancora|dove|senza|dopo|"
                r"ogni|tutti|tutte|sempre|deve|devono|puoi|devi|gli|una|che|\w+zione|\w+zioni)\b", re.I)
# Italian confirm words of earlier consoles, accepted on purpose
LEGACY = {"SOSTITUISCI", "ELIMINA", "RIAVVIA", "PROMUOVI", "DECLASSA"}


def sources():
    for dp, dn, fn in os.walk(ROOT):
        dn[:] = [d for d in dn if d not in ("__pycache__", "tests")]
        for f in fn:
            if f.endswith(".py"):
                yield os.path.join(dp, f)


class EnglishOnly(unittest.TestCase):
    def test_no_italian_strings(self):
        bad = []
        for p in sources():
            with io.open(p, encoding="utf-8") as fh:
                src = fh.read()
            for tok in tokenize.generate_tokens(io.StringIO(src).readline):
                if tok.type != tokenize.STRING:
                    continue
                text = tok.string
                if any(w in text for w in LEGACY):
                    continue
                m = IT.search(text)
                if m:
                    bad.append("%s:%d: %r in %s" % (os.path.relpath(p, ROOT), tok.start[0], m.group(0), text[:90]))
        self.assertEqual(bad, [], "Italian text in agent strings:\n" + "\n".join(bad))


if __name__ == "__main__":
    unittest.main()
