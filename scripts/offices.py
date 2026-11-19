"""Office holders by year (plan step R-3): the Schultheissen of Thun and of Bern and the
Stadtschreiber of Bern, from three German Wikipedia lists, checked against Wikidata and
against the letters themselves.

    python3 scripts/offices.py            # registers/offices.json, docs/OFFICES.md

Inputs (committed):

    registers/offices_wikipedia.tsv   the three lists as they stood on 18.11.2026
                                      (de.wikipedia.org: "Schultheiss von Bern", "Liste der
                                      Schultheissen von Thun", "Liste der Stadtschreiber von
                                      Bern"; CC BY-SA 4.0), up to 1798
    registers/offices_wikidata.json   per name up to 1600: the Wikidata item found by name
                                      search (a human with an HLS id or a description naming
                                      Bern, Thun or the office), with birth, death, HLS id
    readings/gemini-4-argon.jsonl     the letters' text, for the evidence
    dates/dates.jsonl                 the letters' years (scripts/dates.py)

Evidence from the letters is read from the Argon text, not from the regest drafts: an
address or signature where a name stands next to "schultheis ze Thun" (or Bern) or
"statschriber". Only the letter's year as dates.py read it is used; a year whose century
was taken from neighbouring letters is marked as such.

Nothing here is checked by a person. The lists give first (and for Bern last) years; in
Bern two Schultheissen alternated, so a range does not mean the holder presided every year.
"""

from __future__ import annotations

import collections
import csv
import json
import re
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WIKI = ROOT / "registers" / "offices_wikipedia.tsv"
WD = ROOT / "registers" / "offices_wikidata.json"
OUT = ROOT / "registers" / "offices.json"
DOC = ROOT / "docs" / "OFFICES.md"
SOURCES = {
    "bern_schultheiss": "https://de.wikipedia.org/wiki/Schultheiss_von_Bern",
    "thun_schultheiss": "https://de.wikipedia.org/wiki/Liste_der_Schultheissen_von_Thun",
    "bern_stadtschreiber": "https://de.wikipedia.org/wiki/Liste_der_Stadtschreiber_von_Bern",
}
LABEL = {"bern_schultheiss": "Schultheiss von Bern", "thun_schultheiss": "Schultheiss von Thun",
         "bern_stadtschreiber": "Stadtschreiber von Bern"}
OFF_RE = {"schultheiss": r"sch\w{0,3}l\w{0,2}th?\w*|schult\w*", "stadtschreiber": r"stat+\s*s?chr[iy]\w*"}
TOWN_RE = {"thun": r"(?:th?un+|tuwn)\b", "bern": r"b[e]?r+n+e?\b"}


def fold(s: str) -> str:
    s = unicodedata.normalize("NFKD", s.lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    for a, b in (("ß", "ss"), ("ſ", "s"), ("y", "i"), ("w", "u"), ("v", "u"), ("ph", "f"), ("th", "t"), ("ck", "k"), ("tz", "z"),
                 ("ae", "a"), ("oe", "o"), ("ue", "u"), ("uo", "u"), ("ou", "au")):
        s = s.replace(a, b)
    s = re.sub(r"[^a-z ]+", " ", s)
    return re.sub(r"(.)\1+", r"\1", " ".join(s.split()))


def surname_stem(name: str) -> str:
    """The part of a name that a scribe keeps recognisable: the surname, folded, without
    inflection ("von Scharnachthal" -> "scharnachtal", "Schopfer" -> "schopf")."""
    name = re.sub(r"\((?:I+|II)\.\)|\b(?:I+|IV|V)\.|\bd\. [ÄJ]\.|der Jüngere", " ", name)
    toks = fold(name).split()
    if "von" in toks or "vom" in toks:
        i = max(i for i, t in enumerate(toks) if t in ("von", "vom"))
        last = toks[i + 1] if i + 1 < len(toks) else toks[-1]
    else:
        last = toks[-1]
    return re.sub(r"(ern|en|er|s|e|n)$", "", last) if len(last) >= 5 else last


FORE = {"kas": "kas", "cas": "kas", "nic": "nik", "nik": "nik", "cla": "nik", "kla": "nik", "hen": "hen", "hei": "hei",
        "ioh": "han", "joh": "han", "han": "han", "ula": "ulr", "ulr": "ulr", "uli": "ulr", "rud": "rud", "rod": "rud"}


def fore_key(name: str) -> str:
    """The forename's first three letters, folded, with the common pairs joined
    (Caspar ~ Kaspar, Niclaus ~ Claus ~ Niklaus, Johannes ~ Hans, Uolrich ~ Ulrich)."""
    toks = [t for t in fold(re.sub(r"\((?:I+|II)\.\)|\b(?:I+|IV|V)\.", " ", name)).split() if t not in ("her", "herr", "junker", "meister")]
    if not toks or toks[0] in ("von", "vom"):
        return ""
    k = toks[0][:3]
    return FORE.get(k, k)


def same_surname(a: str, b: str) -> bool:
    from difflib import SequenceMatcher
    return a == b or (a[:3] == b[:3] and SequenceMatcher(None, a, b).ratio() >= 0.75)


def letters_text() -> tuple[dict[str, str], dict[str, tuple]]:
    a = {}
    for line in open(ROOT / "readings" / "gemini-4-argon.jsonl", encoding="utf-8"):
        r = json.loads(line)
        a[r["key"]] = r.get("text") or ""
    texts = {}
    for lt in csv.DictReader(open(ROOT / "readings" / "letters.tsv", encoding="utf-8"), delimiter="\t"):
        texts[lt["id"]] = re.sub(r"\s+", " ", " ".join(a.get(k, "") for k in lt["pages"].split(";")))
    years = {}
    for line in open(ROOT / "dates" / "dates.jsonl", encoding="utf-8"):
        r = json.loads(line)
        years[r["id"]] = (r.get("year"), r.get("century"))
    return texts, years


def evidence(stem: str, fore: str, office: str, town: str, texts: dict[str, str], years: dict) -> list[dict]:
    """Letters that name the holder in office in an address or signature: the forename,
    the folded surname, then the office and the town (or the town and the office)."""
    out = []
    for lid, t in texts.items():
        ft = fold(t)
        for m in re.finditer(r"\b" + re.escape(stem[:max(4, len(stem) - 1)]), ft):
            before = ft[max(0, m.start() - 22): m.start()].split()
            if fore and not any(FORE.get(w[:3], w[:3]) == fore for w in before[-3:]):
                continue
            # an address or signature: the office follows the name ("Peter Schopfer schultheis ze
            # Thun", "Heinrich von Speichingen zuo Bern statschriber"), at most two words between
            after = ft[m.end(): m.end() + 60]
            o, t_ = fold_re(OFF_RE[office]), fold_re(TOWN_RE[town])
            if re.match(rf"\w*\W+(?:\w+\W+){{0,2}}?(?:{o})\W+(?:ze|zu|in|von|der stat)\W+(?:{t_})", after) or \
                    re.match(rf"\w*\W+(?:ze|zu)\W+(?:{t_})\W+(?:{o})", after):
                win = ft[max(0, m.start() - 40): m.end() + 70]
                y, c = years.get(lid, (None, None))
                out.append({"letter": lid, "year": y, "century": c, "context": win})
                break
    return out


def fold_re(r: str) -> str:
    return r.replace("th?", "t?").replace("ß", "ss")


def build() -> dict:
    rows = list(csv.DictReader(open(WIKI, encoding="utf-8"), delimiter="\t"))
    wd = json.loads(WD.read_text(encoding="utf-8")) if WD.exists() else {}
    texts, years = letters_text()
    offices = {}
    for off in SOURCES:
        holders = []
        rs = [r for r in rows if r["office"] == off]
        for i, r in enumerate(rs):
            frm = int(r["from"]) if r["from"] else None
            to = int(r["to"]) if r.get("to") else None
            nxt = next((int(x["from"]) for x in rs[i + 1:] if x["from"] and int(x["from"]) > (frm or 0)), None)
            h = {"name": r["name"], "from": frm, "to": to, "note": r.get("note") or None, "next_from": nxt if off == "thun_schultheiss" else None}
            key = re.sub(r"\s+", " ", re.sub(r"\s*\((I+\.?)\)|\s+(I+|IV|V)\.\s", " ", r["name"])).strip()
            w = wd.get(key)
            flags = []
            if w and frm:
                lo, hi = (w.get("birth") or w.get("death") or frm) - 50, (w.get("death") or w.get("birth") or frm) + 50
                if not lo <= frm <= hi:
                    w = None  # a namesake from another century, found by the name search
            if w and (off, r["name"]) in NAMESAKES:
                h["wikidata_namesake"] = w["qid"]
                w = None
            if w:
                h["wikidata"] = {k: w.get(k) for k in ("qid", "label", "desc", "birth", "death", "hls")}
            if w and frm:
                last = to or frm
                if w.get("birth") and (w.get("bprec") or 0) >= 9 and frm < w["birth"] + 15:
                    flags.append(f"wikidata: in office {frm}, but {w['qid']} born {w['birth']}")
                if w.get("death") and (w.get("dprec") or 0) >= 9 and last > w["death"]:
                    flags.append(f"wikidata: in office until {last}, but {w['qid']} died {w['death']}")
                if w.get("birth") and w.get("death") and w["birth"] > w["death"]:
                    flags.append(f"wikidata: {w['qid']} born {w['birth']} after death {w['death']}")
            if frm and frm >= 1380 and frm <= 1600 and off != "bern_schultheiss" or (off == "bern_schultheiss" and frm and 1380 <= frm <= 1600):
                office, town = ("stadtschreiber", "bern") if off == "bern_stadtschreiber" else ("schultheiss", off.split("_")[0])
                ev = evidence(surname_stem(r["name"]), fore_key(r["name"]), office, town, texts, years)
                if ev:
                    h["letters"] = ev
                    written = sorted(e["year"] for e in ev if e["year"] and e["century"] == "written")
                    if off == "thun_schultheiss":
                        # only letters from within reach of the list's year count as this holder's
                        near = [y for y in written if frm - 15 <= y <= frm + 40]
                        if near and min(near) < frm:
                            flags.append(f"letters: in office {min(near)}, list: from {frm}")
                        if near and nxt and max(near) >= nxt:
                            flags.append(f"letters: still in office {max(near)}, list: next holder from {nxt}")
                    else:
                        near = [y for y in written if (frm or 0) - 15 <= y <= (to or frm or 0) + 15]
                        if near and frm and min(near) < frm:
                            flags.append(f"letters: in office {min(near)}, list: from {frm}")
                        if near and to and max(near) > to:
                            flags.append(f"letters: in office {max(near)}, list: to {to}")
            h["flags"] = flags
            rv = REVIEW.get((off, r["name"], frm)) or REVIEW.get((off, r["name"]))
            if rv:
                h["review"] = rv
            holders.append(h)
        offices[off] = {"label": LABEL[off], "source": SOURCES[off], "holders": holders}
    offices["thun_schultheiss"]["not_in_list"] = discover(
        [(fore_key(h["name"]), surname_stem(h["name"])) for h in offices["thun_schultheiss"]["holders"]], texts, years)
    return offices


# Read by hand on 18.11.2026 (the agent, not a historian): what each automatic flag turned
# out to be. Namesakes: the Wikidata item the name search found is another man of that name.
REVIEW = {
    ("thun_schultheiss", "Peter Schopfer"): "contradiction: addressed as Schultheiss of Thun from 3.10.1439 (BAT 664, Nr. 48) to 1448 in letters with the year written out (1439: 3, 1440: 16, 1441: 9, 1442: 11, 1443: 6, 1444: 2, 1445: 8, 1447: 1, 1448: 1); the list has him from 1440, Niklaus von Wattenwyl from 1444",
    ("thun_schultheiss", "Kaspar von Scharnachthal"): "contradiction: addressed as Schultheiss of Thun 1450-1461 (1461 written out, BAT 665, Nr. 52); the list has Ulrich von Laupen 1455, Ulrich von Erlach 1456, Niklaus von Scharnachthal 1458, Ludwig Brüggler 1459. Two letters dated 1400 and 1403 (year written out, BAT 665, Nr. 90 and 99) name a 'junkher Caspar von Scharnachtal schultheis ze Thun': an earlier Kaspar, or a misread year; to check on the image",
    ("thun_schultheiss", "Ulrich von Laupen"): "contradiction: addressed as Schultheiss of Thun in ten letters dated 1463-1477 (centuries from neighbouring letters); the list has him in 1455 only",
    ("thun_schultheiss", "Ludwig Brüggler", 1459): "addressed as Schultheiss of Thun 1454-1462 (centuries from neighbours; the list: from 1459) and in letters read as 1370/1371/1378, which are 1470s with the century taken wrongly (Ludwig Brüggler II., list 1471)",
    ("thun_schultheiss", "Gilian Achshalm"): "contradiction: addressed as Schultheiss of Thun 1472-1488 (centuries from neighbours); the list: 1476, Thüring von Erlach from 1478",
    ("thun_schultheiss", "Ludwig von Diesbach"): "one letter of 1472 (year written out, BAT 666, Nr. 142) addresses 'junker Ludwig von Diesbach, Schultheiss ... von Thun'; the list: 1482. 1472 may be 1482 misread; to check. Wikidata's Ludwig von Diesbach (Q125845943, born 1484) is a namesake",
    ("thun_schultheiss", "Antoni Bütschelbach"): "contradiction: signs as Schultheiss of Thun in 1521 (year written out, BAT 666.1, Nr. 455); the list: 1518, Urban Baumgartner from 1520",
    ("thun_schultheiss", "Hans von Erlach"): "no contradiction: the letter of 1412 names him as a burgher, not as Schultheiss",
    ("thun_schultheiss", "Niklaus von Wattenwyl"): "no contradiction: the letter of 1439 names him without an office",
    ("thun_schultheiss", "Jacob Michel"): "no contradiction: the letter of 1577 calls him 'dozemaln unserm schultheissen ... salig', Schultheiss at that time, now dead",
    ("thun_schultheiss", "Christian Willading"): "namesake: Wikidata's Q58821592 is born 1611",
    ("thun_schultheiss", "Niklaus Dachselhofer"): "namesake: Wikidata's Q7035384 (1595-1670) is the Bern Schultheiss of 1636-1667, not the Thun Schultheiss of 1596",
    ("bern_stadtschreiber", "Niklaus Zurkinden"): "namesake: Wikidata's Q121761328 is born 1586; the Stadtschreiber of 1561 is the reformer Niklaus Zurkinden (1506-1588)",
    ("bern_stadtschreiber", "Samuel Zurkinden"): "Wikidata error: Q78076307 has died 1553, its own description says died 24.9.1577",
    ("bern_stadtschreiber", "Heinrich von Speichingen"): "contradiction: signs as Stadtschreiber of Bern in 1441 (year written out, BAT 663.1, Nr. 396); the list: to 1439, Johannes Blum from 1439",
    ("bern_schultheiss", "Otto von Bubenberg"): "contradiction: the list has him to 1393, Wikidata (Q88264746) died 1392",
}
NAMESAKES = {k for k, v in REVIEW.items() if v.startswith("namesake")} | {("thun_schultheiss", "Ludwig von Diesbach")}


ADDRESS = re.compile(r"([A-ZÄÖÜ][a-zäöüß]+(?:\s+(?:von|vom)\s+[A-ZÄÖÜ][a-zäöüß]+|\s+[A-ZÄÖÜ][a-zäöüß]+))[,]?\s+"
                     r"(?:unserm\s+|unsrem\s+)?(?:sch\w{0,3}l\w{0,2}th?\w*|schult\w*)\s+(?:ze|zuo|zu|zů)\s+(?:Th?un+)\b")


def discover(known: list[tuple[str, str]], texts: dict[str, str], years: dict) -> list[dict]:
    """Names the letters give as Schultheiss of Thun (in an address or signature) whose
    surname is in no entry of the list."""
    found = collections.defaultdict(list)
    for lid, t in texts.items():
        for m in ADDRESS.finditer(t):
            name = m.group(1)
            if re.match(r"(?:Unser|Dem|Den|Und|Lieben|Burger|Rat|Ratt)\b", name):
                continue
            stem, fk = surname_stem(name), fore_key(name)
            if len(stem) < 3 or any(same_surname(stem, s) and (not f or not fk or f == fk) for f, s in known):
                continue
            y, c = years.get(lid, (None, None))
            key = next((k for k in found if same_surname(k[1], stem) and (k[0] == fk or not k[0] or not fk)), (fk, stem))
            found[key].append({"letter": lid, "name": name, "year": y, "century": c})
    out = []
    for stem, ev in sorted(found.items(), key=lambda kv: -len(kv[1])):
        names = collections.Counter(e["name"] for e in ev)
        ys = sorted(e["year"] for e in ev if e["year"])
        out.append({"name": names.most_common(1)[0][0], "spellings": dict(names), "letters": ev,
                    "years": [ys[0], ys[-1]] if ys else None})
    return out


def main() -> None:
    offices = build()
    OUT.write_text(json.dumps({"about": __doc__.strip().split("\n\n")[0] + " Generated by scripts/offices.py; unchecked.",
                               "offices": offices}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    n = {k: len(v["holders"]) for k, v in offices.items()}
    nf = sum(1 for v in offices.values() for h in v["holders"] if h["flags"])
    print(f"registers/offices.json: {n}; {nf} holders flagged")


if __name__ == "__main__":
    main()
