"""A register of persons, places and organisations for the Thun Missives, built
from the automatic tagging and matched against four authorities (plan R-1, R-2;
docs/NER_REGISTER_PLAN.md, docs/REGISTER.md).

    register.py groups                 # the names, grouped and counted, and what was dropped
    register.py link [--workers 4]     # look up, grade, write registers/*.json
    register.py docs                   # docs/places_without_coordinates.md
    register.py sample [--n 30]        # a random draw for the spot check (docs/REGISTER.md)

Input: ``entities/gemini-4-argon.jsonl`` (St. Gallen's combined tagger on the
Argon reading, scripts/ner_llm.py; not measured on Thun), ``readings/letters.tsv`` (page -> letter)
and ``dates/dates.jsonl`` (the letters' years; persons are dated by these, not by
page years).

**Entries (R-1).** Names are folded as in St. Gallen (``key``: u/v/w, i/y,
doubled letters, accents; ``skey`` adds ph/f, th/t, tz/z, ck/k, ae/oe/ue …):

* places: one entry per folded spelling, a trailing inflection (Berne, Thuno)
  joined to its stem, then spellings whose best candidate is the same settlement
  («wahrscheinlich», same HLS or SSRQ id) joined into one entry;
* organisations: the address formula is normalised ("Schulths und rat ze Berne"
  -> "Schultheiss und Rat zu Bern", the St. Gallen register's form), with the
  place read through the place entries; other names by folded spelling;
* persons: spellings that agree (>= 90 after folding, forenames stemmed:
  Petern -> Peter) and letters within 30 years of the first one. A mention
  without a year joins only a name that has a single entry. Offices are not
  used to merge (not done yet). Dropped and counted: fragments, titles and
  offices alone (Schulthes, alt, von), bare forenames (Peter, Hensli) and
  names that are a place's (Thun, Inderlapen).

**Matching (R-2)**, every entry against HLS (our MCP: persons, places), SSRQ
(MCP: persons, organisations; loci.ssrq-sds-fds.ch: places), Königsfelden (MCP)
and St. Gallen (the edition's register, person/ and place/ of
DHBern/sg-missiven-data; its generated entries for cross-links only). Grades
follow St. Gallen's rules (scripts/auto_register.py, scripts/ssrq_match.py
there): places never «sicher», SSRQ and Königsfelden (an SSRQ edition with the
same ids) at most «wahrscheinlich», persons only where the letters' years fit.
Candidates naming the same HLS or SSRQ id are folded into one, with the better
grade. The precision St. Gallen measured for each rule goes beside the grade.

**Coordinates** only from a matched candidate: the St. Gallen register, the
Königsfelden place, the HLS article, or Wikidata by the candidate's HLS id
(P902 -> P625, one query at a time). Never from a name alone.

Answers are cached in registers/.cache/ (not committed): a rerun asks only for
what is new. St. Gallen's register files are fetched from GitHub into the cache
(``--sg`` takes a local checkout instead).
"""

from __future__ import annotations

import argparse
import collections
import concurrent.futures as cf
import csv
import datetime as dt
import hashlib
import html
import json
import math
import random
import re
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

from rapidfuzz import fuzz

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from mcp_client import MCP  # noqa: E402

READER = "gemini-4-argon"
OUT = ROOT / "registers"
CACHE = OUT / ".cache"
UA = "thun-missiven-register/1.0 (DH Bern research; register linking)"
THUN = (46.7580, 7.6280)
SG_RAW = "https://raw.githubusercontent.com/DHBern/sg-missiven-data/main/"
SG_SITE = "https://dhbern.github.io/sg-missiven-data/"
LOCI = "https://loci.ssrq-sds-fds.ch"
WDQS = "https://query.wikidata.org/sparql"
GRADES = ("sicher", "wahrscheinlich", "möglich")
RANK = {"sicher": 0, "wahrscheinlich": 1, "möglich": 2}

# What St. Gallen measured for each rule (sg-missiven-data registers/auto_register_measure.json,
# 14.11.2026, and registers/ssrq_measure.json, 15.11.2026): on the edition's own entries, so
# for Thun these are borrowed figures, not Thun measurements (docs/REGISTER.md).
MEASURED = {
    "name": {"source": "sg-missiven-data registers/auto_register_measure.json (14.11.2026)",
             "per": {"sicher": [35, 37], "wahrscheinlich": [6, 9], "möglich": [6, 10]},
             "place": {"wahrscheinlich": [61, 82], "möglich": [19, 77]}},
    "ssrq": {"source": "sg-missiven-data registers/ssrq_measure.json (15.11.2026)",
             "per": {"wahrscheinlich": [97, 99], "möglich": [62, 99]},
             "place": {"wahrscheinlich": [52, 56], "möglich": [44, 73]}},
}

# ------------------------------------------------------------------ folding


def key(s: str) -> str:
    """St. Gallen's folding (sg-missiven-data scripts/ner.py ``key``)."""
    s = unicodedata.normalize("NFKD", s.lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.replace("ß", "ss").replace("ſ", "s").replace("v", "u").replace("y", "i").replace("w", "u")
    s = re.sub(r"(.)\1+", r"\1", s)
    return " ".join(re.findall(r"[a-z0-9]+", s))


def skey(s: str) -> str:
    """``key`` and a few more of the scribes' habits (sg-missiven-data scripts/ssrq_match.py)."""
    k = key(s)
    for a, b in (("ph", "f"), ("th", "t"), ("dt", "t"), ("tz", "z"), ("ck", "k"), ("c", "k"), ("ae", "e"),
                 ("oe", "o"), ("ue", "u"), ("ie", "i")):
        k = k.replace(a, b)
    return re.sub(r"(.)\1+", r"\1", k)


def lenis(k: str) -> str:
    """Upper German scribes write hard and soft consonants for one another (t/d, p/b, k/g)."""
    return k.translate(str.maketrans("tpk", "dbg"))


def flat(s: str) -> str:
    return " ".join((s or "").split())


def km(a, b) -> float:
    la1, lo1, la2, lo2 = map(math.radians, (*a, *b))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def year_int(v) -> int | None:
    m = re.search(r"(\d{3,4})", str(v or ""))
    return int(m.group(1)) if m else None


def hls_id(v) -> str | None:
    m = re.search(r"(\d+)", str(v or ""))
    return m.group(1).zfill(6) if m else None


# ------------------------------------------------------------------ cache, servers


def cached(k: str, fetch):
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / (hashlib.sha1(k.encode()).hexdigest() + ".json")
    if f.exists():
        return json.loads(f.read_text())["v"]
    v = fetch()
    f.write_text(json.dumps({"k": k, "v": v}, ensure_ascii=False))
    return v


_lock: dict[str, threading.Lock] = collections.defaultdict(threading.Lock)
_mcp: dict[str, MCP] = {}


def mcp_call(server: str, tool: str, **args):
    """One call at a time per server (the sessions do not take concurrent calls),
    three tries; a dropped session is opened again."""
    for attempt in range(3):
        with _lock[server]:
            try:
                if server not in _mcp:
                    _mcp[server] = MCP(server, timeout=90).open()
                return _mcp[server].call(tool, **args)
            except (urllib.error.URLError, TimeoutError, RuntimeError, OSError) as exc:
                _mcp.pop(server, None)
                if attempt == 2:
                    raise RuntimeError(f"{server}.{tool} failed: {exc}") from exc
        time.sleep(3 * (attempt + 1))


_HTTP_SLOTS = threading.Semaphore(2)
_HTTP_LOCK = threading.Lock()
_http_last = [0.0]


def http_get(url: str, data: bytes | None = None, headers: dict | None = None, gap: float = 0.5) -> str:
    """At most two requests at a time and two starts a second; on 429/5xx wait as asked (Retry-After)."""
    for attempt in range(6):
        with _HTTP_SLOTS:
            with _HTTP_LOCK:
                wait = gap - (time.time() - _http_last[0])
                if wait > 0:
                    time.sleep(wait)
                _http_last[0] = time.time()
            try:
                req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, **(headers or {})})
                with urllib.request.urlopen(req, timeout=90) as r:
                    return r.read().decode("utf-8", "replace")
            except urllib.error.HTTPError as e:
                if e.code not in (429, 500, 502, 503, 504):
                    raise
                delay = int(e.headers.get("Retry-After") or 0) or 10 * (attempt + 1)
            except (urllib.error.URLError, TimeoutError):
                delay = 10 * (attempt + 1)
        time.sleep(min(delay, 120))
    raise RuntimeError(f"no answer from {url[:80]}")


# ------------------------------------------------------------------ the corpus


def letter_maps() -> tuple[dict[str, list[str]], dict[str, int], list[str]]:
    """page key -> letter ids, letter id -> year (dates/dates.jsonl), letters in order."""
    pages: dict[str, list[str]] = collections.defaultdict(list)
    order = []
    with (ROOT / "readings" / "letters.tsv").open(encoding="utf-8") as fh:
        for r in csv.DictReader(fh, delimiter="\t"):
            order.append(r["id"])
            for k in (r["pages"] + ";" + (r.get("extra") or "")).split(";"):
                if k:
                    pages[k].append(r["id"])
    years = {}
    path = ROOT / "dates" / "dates.jsonl"
    for line in path.read_text(encoding="utf-8").splitlines() if path.exists() else []:
        if line.strip():
            r = json.loads(line)
            if isinstance(r.get("year"), int):
                years[r["id"]] = r["year"]
    return pages, years, order


def mentions() -> list[dict]:
    """Every tagged person, organisation and place, with its page, letter and year."""
    pages, years, _ = letter_maps()
    out = []
    for line in (ROOT / "entities" / f"{READER}.jsonl").read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        lids = pages.get(r["key"], [])
        for e in r["entities"]:
            if e["type"] not in ("per", "org", "place"):
                continue
            out.append({"type": e["type"], "text": flat(e["text"]), "page": r["key"], "start": e["start"],
                        "end": e["end"], "role": e.get("role") or ("origPlace" if e.get("el") == "origPlace" else ""),
                        "ref": e.get("ref"), "letters": lids,
                        "year": next((years[x] for x in lids if x in years), None)})
    return out


# ------------------------------------------------------------------ St. Gallen's registers

TEI = "{http://www.tei-c.org/ns/1.0}"
XID = "{http://www.w3.org/XML/1998/namespace}id"


def sg_file(name: str, sg: str | None) -> str:
    if sg:
        return (Path(sg) / name).read_text(encoding="utf-8")
    return cached(f"sg-file:{name}", lambda: http_get(SG_RAW + name, gap=0.2))


def sg_registers(sg: str | None) -> dict[str, dict]:
    """The St. Gallen edition's persons, organisations and places: names (all
    spellings, dates in brackets dropped), coordinates, HLS and SSRQ ids, and for
    persons the year of first attestation."""
    reg = {}
    for fname, kinds in (("person/person.xml", ("person", "org", "personGrp")), ("place/place.xml", ("place",))):
        # the header carries prose that is not well-formed XML; the lists are in the body
        root = ET.fromstring(re.sub(r"<teiHeader\b.*?</teiHeader>", "", sg_file(fname, sg), flags=re.S))
        for kind in kinds:
            for el in root.iter(TEI + kind):
                xid = el.get(XID)
                if not xid:
                    continue
                names, main = [], None
                for n in el:
                    if n.tag in (TEI + "persName", TEI + "orgName", TEI + "placeName"):
                        t = flat(re.sub(r"\s*\([^)]*\)", "", "".join(n.itertext())))
                        if n.get("type") == "sort" or not t:
                            continue
                        if n.get("type") == "main":
                            main = t
                        if "," in t and kind == "person":  # "Wasen, Konrad am" -> "Konrad am Wasen"
                            last, first = t.split(",", 1)
                            t = flat(f"{first} {last}")
                        names.append(t)
                links = [p.get("target") for p in el.iter(TEI + "ptr") if p.get("target")]
                hls = next((hls_id(m.group(1)) for u in links for m in [re.search(r"hls-dhs-dss\.ch/\w+/articles/(\d+)", u)] if m), None)
                ssrq = next((m.group(1) for u in links for m in [re.search(r"\b((?:per|org|loc)\d{6})\b", u)] if m), None)
                e = {"id": xid, "kind": "org" if kind == "personGrp" else kind, "name": main or (names[0] if names else xid),
                     "names": list(dict.fromkeys(names)), "hls": hls, "ssrq": ssrq}
                b = el.find(TEI + "birth")
                if b is not None and year_int(b.get("when")):
                    e["first"] = year_int(b.get("when"))
                if kind == "place":
                    g = el.find(f"{TEI}location/{TEI}geo")
                    if g is not None and g.text and len(g.text.split()) == 2:
                        e["geo"] = [round(float(x), 5) for x in g.text.split()]
                    e["ftype"] = el.get("type") or ""
                reg[xid] = e
    return reg


def sg_auto(sg: str | None) -> dict[str, dict]:
    """St. Gallen's generated entries (registers/auto_register.json): used only to
    cross-link, where both sides point to the same HLS article."""
    try:
        return json.loads(sg_file("registers/auto_register.json", sg)).get("entries", {})
    except Exception:  # noqa: BLE001
        return {}


# ------------------------------------------------------------------ HLS lists (local matching)


def hls_geo() -> list[dict]:
    """Every geographical article of our HLS server, with its coordinates. The
    server's list is not complete (Bern, Thun and Spiez as municipalities are
    missing on 17.11.2026); the SSRQ and Königsfelden fill the gaps with HLS ids."""
    def fetch():
        out = []
        for off in range(0, 20000, 500):
            r = mcp_call("hls", "list_articles_by_category", category="geo", limit=500, offset=off)
            if not r:
                break
            out += [{"id": x["id"], "title": x["title"], "lat": x.get("lat"), "lon": x.get("lon"),
                     "cls": [c.split("->")[-1].strip() for c in x.get("lexical_class") or []]} for x in r]
        return out
    return cached("hls-geo-list:v1", fetch)


def hls_wd_places() -> list[dict]:
    """The HLS articles of places that our HLS server lacks, by their HLS id on
    Wikidata (P902), with Wikidata's coordinates and German label: Swiss items
    only, two queries in all (the Query Service, not the search API that refused
    St. Gallen with 429). A municipality or former municipality counts as a settlement."""
    def ask(q):
        body = urllib.parse.urlencode({"query": q}).encode()
        return json.loads(http_get(WDQS, body, {"Accept": "application/sparql-results+json",
                                               "Content-Type": "application/x-www-form-urlencoded"}, gap=3.0))["results"]["bindings"]

    def fetch():
        rows = ask('SELECT ?i ?h ?c ?l WHERE { ?i wdt:P902 ?h ; wdt:P17 wd:Q39 ; wdt:P625 ?c ; rdfs:label ?l . FILTER(lang(?l)="de") }')
        muni = {b["i"]["value"] for b in ask('SELECT DISTINCT ?i WHERE { VALUES ?t { wd:Q70208 wd:Q685309 } ?i wdt:P902 ?h ; wdt:P31 ?t . }')}
        out = []
        for b in rows:
            m = re.match(r"Point\(([-\d.eE]+) ([-\d.eE]+)\)", b["c"]["value"])
            if m:
                out.append({"id": hls_id(b["h"]["value"]), "title": b["l"]["value"], "lat": round(float(m.group(2)), 5),
                            "lon": round(float(m.group(1)), 5), "wikidata": b["i"]["value"].rsplit("/", 1)[1],
                            "cls": ["Gemeinde"] if b["i"]["value"] in muni else []})
        return out
    return cached("hls-wd-places:v1", fetch)


def hls_persons() -> list[dict]:
    def fetch():
        out = []
        for off in range(0, 60000, 500):
            r = mcp_call("hls", "list_persons", limit=500, offset=off)
            if not r:
                break
            out += [{"id": x["article_id"], "first": x.get("first_name") or "", "family": x.get("family_name") or "",
                     "birth": year_int(x.get("birth_date")), "death": year_int(x.get("death_date"))} for x in r]
        return out
    return cached("hls-person-list:v1", fetch)


TYPE_WORDS = {"gemeinde", "herrschaft", "amtsbezirk", "vogtei", "landvogtei", "kloster", "stift", "kanton", "bezirk",
              "grafschaft", "burg", "schloss", "ehemalige", "stadt", "dorf", "kastlanei", "landschaft", "region",
              "propstei", "komturei", "abtei", "priorat", "pfarrei", "kirche", "bistum", "fürstbistum", "fürstabtei",
              "talschaft", "freiherrschaft", "landgrafschaft", "herzogtum", "verwaltungskreis"}


def base_name(title: str) -> str:
    """'Thun Vogtei, Amtsbezirk' -> 'Thun'; 'Oberhofen (AG)' -> 'Oberhofen';
    'Oberhofen am Thunersee' -> 'Oberhofen'."""
    t = re.sub(r"\s*\([^)]*\)", "", title.split(",")[0]).strip()
    t = re.sub(r"\s+(am|an der|bei|im|in der|ob|sur|près|sous)\s+\S.*$", "", t)
    words = t.split()
    while len(words) > 1 and words[-1].lower() in TYPE_WORDS:
        words.pop()
    return " ".join(words)


SETTLEMENT_CLS = re.compile(r"Gemeinde|Stadt|Dorf|Siedlung|Weiler|Flecken", re.I)
SETTLEMENT = re.compile(r"Stadt|Dorf|Gemeinde|Weiler|Flecken|Markt|Land|Herrschaft|Vogtei|Grafschaft|Kanton|Bistum|"
                        r"Fürstentum|Herzogtum|Königreich|Reich|Region|Gebiet|Landschaft|Amt|Kloster|Abtei", re.I)


# ------------------------------------------------------------------ SSRQ places (loci), after ssrq_match.py


def _text(s: str) -> str:
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", s)).split())


def loci_search(query: str) -> list[dict]:
    """sg-missiven-data scripts/ssrq_match.py ``loci_search``."""
    langs = ["deu", "fra", "ita", "lat", "roh"]
    countries = ["CH", "DE", "AT", "FR", "IT", "LI",
                 "AL|BE|BG|BR|CY|CZ|DK|EG|ES|GB|GI|GR|HR|HU|IE|IL|IS|IQ|JO|LB|LU|LT|ME|MT|NL|PL|PS|PT|RO|RU|SE|SI|SK|SY|TN|TR|US|VA|0"]

    def ask():
        body = urllib.parse.urlencode([("query", query)] + [("lang", x) for x in langs]
                                      + [("country", x) for x in countries]).encode()
        page = http_get(f"{LOCI}/search/search.xq", body)
        rows = []
        for tr in re.findall(r"<tr>(.*?)</tr>", page, re.S):
            td = re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)
            if len(td) >= 5 and re.match(r"loc\d+", _text(td[0])):
                rows.append({"id": _text(td[0]), "name": _text(td[1]), "type": _text(td[2]),
                             "region": _text(td[3]), "part_of": _text(td[4])})
        return rows
    return cached(f"loci-search:{query}", ask)


def loci_place(lid: str) -> dict:
    def ask():
        page = http_get(f"{LOCI}/views/view-place.xq?id={lid}")
        name = _text((re.search(r"<h3>(.*?)</h3>", page, re.S) or [None, ""])[1])
        variants = []
        m = re.search(r"Schreibvarianten.*?<tbody>(.*?)</tbody>", page, re.S)
        if m:
            for tr in re.findall(r"<tr>(.*?)</tr>", m.group(1), re.S):
                td = re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)
                if len(td) >= 2 and _text(td[1]):
                    variants.append(_text(td[1]))
        hls = re.search(r"hls-dhs-dss\.ch/(?:textes/d/D|de/articles/)0*(\d+)", page)
        gnd = re.search(r"d-nb\.info/gnd/([0-9X-]+)", page)
        on = re.search(r"ortsnamen\.ch/record/(\d+)", page)
        return {"id": lid, "name": name, "variants": variants,
                "hls": hls.group(1).zfill(6) if hls else None, "gnd": gnd.group(1) if gnd else None,
                "ortsnamen": on.group(1) if on else None}
    return cached(f"loci-place:{lid}", ask)


def _lucene(s: str) -> str:
    return re.sub(r'([+\-!(){}\[\]^"~*?:\\/&|])', r"\\\1", s)


def loci_candidates(forms: list[str], top: int = 4) -> list[dict]:
    terms = []
    for f in forms:
        for v in (f, f.replace("y", "i").replace("Y", "I"), re.sub(r"(.)\1+", r"\1", f)):
            for w in [v] if " " not in v.strip() else [v.split()[0], v.split()[-1]]:
                t = _lucene(w.strip())
                if len(t) >= 3 and t + "~" not in terms:
                    terms.append(t + "~")
    if not terms:
        return []
    hits = loci_search(" OR ".join(terms))[:25]
    hits.sort(key=lambda h: -max(fuzz.ratio(skey(f), skey(h["name"])) for f in forms))
    out = []
    for h in hits[:top]:
        if max(fuzz.ratio(skey(f), skey(h["name"])) for f in forms) < 60 and not any(
                skey(h["name"]).startswith(skey(f)[:4]) for f in forms):
            continue  # a far name: its page (variants) is not worth a request
        p = loci_place(h["id"])
        out.append({"src": "ssrq", "ssrq": h["id"], "label": p["name"] or h["name"],
                    "names": [p["name"] or h["name"], *p["variants"]], "type": h["type"], "region": h["region"],
                    "hls": p["hls"], "gnd": p["gnd"], "ortsnamen": p["ortsnamen"],
                    "settlement": bool(SETTLEMENT.search(h["type"]))})
    return out


# ------------------------------------------------------------------ R-1: grouping

PARTICLES = {"uon", "von", "und", "ze", "zuo", "zu", "zue", "der", "die", "das", "dem", "den", "des", "am", "im", "in",
             "uf", "uff", "an", "ab", "uor", "mit", "sin", "min", "unser", "uns", "sant", "s", "e", "et", "de", "da",
             "etc", "her", "ir", "si", "er"}
OFFICES = {"schulthes", "schultheis", "schultheisen", "schulthesen", "schulths", "schulthen", "schulthn", "schultz",
           "schultzn", "schulten", "schultn", "schulteis", "alt", "alten", "alte", "heren", "herr", "her", "here",
           "herren", "rat", "rate", "raet", "raeten", "uogt", "uogte", "uogten", "uenner", "uener", "meister",
           "burger", "burgern", "statschriber", "schriber", "kilchher", "priester", "pfarer", "graf", "grafen",
           "junkher", "iunkher", "ritter", "frau", "fro", "frouw", "frou", "botten", "bott", "bote", "lantuogt",
           "amman", "aman", "seckelmeister", "spitaluogt", "tschachtlan", "kastlan", "castlan", "edlen", "edel",
           "strengen", "fromen", "uesten", "wisen", "lieben", "getruen", "selig", "seligen", "brueder", "bruoder",
           "sun", "son", "uater", "muoter", "wib", "husfrou", "kneht", "knecht", "diener", "pfister", "weibel",
           "uogtz", "hoptman", "houptman", "hauptman", "comentur", "abt", "probst", "bischof", "kung", "kunig",
           "keiser", "herzog", "hertzog", "marggraf", "fryherr", "frier", "bapst", "babst", "papst", "kunig", "kung",
           "keiser", "kaiser", "kilcher", "kilchen", "dechan", "techan", "official", "landuogt"}
# forenames: St. Gallen's register and HLS give most; these Thun diminutives and inflections they do not
FORENAMES_EXTRA = {"hensli", "henslin", "hensl", "heini", "heinin", "heinj", "cleui", "cleuin", "cleuj", "ueli", "uelin",
                   "uli", "ulin", "hentz", "heintz", "heintzman", "peterman", "petterman", "iacob", "iohans", "iohannes",
                   "ianni", "rudi", "ruedi", "ruodi", "ruof", "cuoni", "kuoni", "cuontz", "kuntz", "cuntz", "uolrich",
                   "ruodolf", "niclaus", "claus", "clewi", "bendicht", "benedict", "cristan", "cristen", "stefan", "andres",
                   "bernhart", "berchtold", "burkart", "anthoni", "wilhelm", "ulman", "hans", "hanns", "peter", "heinrich",
                   "jost", "iost", "jos", "uolin", "ulrich", "ruodolff", "erhart", "lienhart", "lienhard", "gilian", "jacob",
                   "jorg", "iorg", "georg", "jerg", "thoman", "toman", "tomas", "anshelm", "cuonrat", "cunrat", "conrat",
                   "kuonrat", "wernli", "werli", "werner", "matis", "mathis", "batt", "bat", "michel", "marti", "martin",
                   "caspar", "kaspar", "gabriel", "lux", "lucas", "urban", "simon", "symon", "bartlome", "batlome",
                   "paulus", "felix", "adrian", "ludwig", "loy", "melcher", "baltasar", "dietrich", "egli", "itel",
                   "ital", "ioss", "anna", "elsi", "elsbeth", "greda", "gret", "margret", "katharina", "trina", "verena",
                   "frena", "agnes", "barbara", "dorothea", "magdalena", "madlen", "ita", "ursula", "elsen", "hansen",
                   "petern", "heinrichen", "clausen", "uolrichen"}


def forenames(sg_reg: dict, hls_people: list[dict]) -> set[str]:
    c = collections.Counter()
    for p in hls_people:
        for w in key(p["first"]).split():
            c[w] += 1
    names = {w for w, n in c.items() if n >= 3 and len(w) > 2}
    for e in sg_reg.values():
        if e["kind"] == "person" and e["names"]:
            n = e["names"][0].split()
            if len(n) >= 2:
                names.add(key(n[0]))
    return names | {key(w) for w in FORENAMES_EXTRA}


def stem_forename(w: str, fn: set[str]) -> str | None:
    """'petern' -> 'peter', 'hansen' -> 'hans', 'heinrichen' -> 'heinrich' (an inflected forename)."""
    if w in fn:
        return w
    for suf in ("en", "n", "s", "in", "e"):
        if w.endswith(suf) and len(w) - len(suf) >= 3 and w[: -len(suf)] in fn:
            return w[: -len(suf)]
    return None


def norm_person(text: str, fn: set[str]) -> tuple[str, str]:
    """(grouping key, why dropped or ''): forenames stemmed, particles kept between names."""
    k = key(text)
    words = k.split()
    if len(k) < 3 or any(c.isdigit() for c in k):
        return "", "fragment"
    if all(w in PARTICLES for w in words):
        return "", "particle only"
    if all(w in OFFICES or w in PARTICLES for w in words):
        return "", "title or office only"
    core = [w for w in words if w not in OFFICES]
    stems = [stem_forename(w, fn) or w for w in core]
    if all(stem_forename(w, fn) or w in PARTICLES for w in core):
        return "", "forename only"
    if len(core) == 1 and len(core[0]) >= 4:  # a forename spelled otherwise (Burckart, Conradus, Margarethen)
        w = lenis(skey(core[0]))
        if any(f[:1] == w[:1] and fuzz.ratio(w, lenis(skey(f))) >= 85 for f in fn if len(f) >= 4):
            return "", "forename only"
    return skey(" ".join(stems)), ""


PREP = {"ze", "zuo", "zu", "zue", "zo", "zur", "zem", "in", "uon", "uf", "uff", "stat", "stad", "stadt"}
# the scribes' abbreviations of Bern (a stroke for -er-)
PLACE_ABBR = {"brn": "bern", "brne": "bern", "bne": "bern", "bnne": "bern", "bn": "bern"}


def is_office(w: str) -> bool:
    return w in OFFICES or w.startswith(("schult", "schulz")) or bool(re.fullmatch(r"r(a|ae|au|e)t+(e|en|n)?", w))


def org_formula(text: str, place_name) -> tuple[str, str]:
    """'Schulths und rat ze Berne' -> ('Schultheiss und Rat zu Bern', ''); a title alone -> ('', why).
    ``place_name`` maps a folded place spelling to its entry's name (or None)."""
    k = key(text)
    w = k.split()
    if len(k) < 3 or any(c.isdigit() for c in k):
        return "", "fragment"
    w = [x for x in w if x not in ("etc", "unnd")] or w
    if all(x in PARTICLES or is_office(x) or x in ("und", "unnd", "etc") for x in w):
        return "", "title or office only"
    has_s = any(x.startswith(("schult", "schulth", "schulz")) for x in w)
    has_bm = any(x.startswith(("burgermeist", "burgermaist", "burgemeist")) for x in w)
    has_r = any(re.fullmatch(r"r(a|ae|au|e)t(e|en|n)?", x) for x in w)
    # the place: the last word after a preposition, or a "die von X" / "X" alone
    pl = None
    for i, x in enumerate(w):
        if x in PREP and i + 1 < len(w):
            pl = " ".join(w[i + 1:])
    if (has_s or has_bm or has_r) and pl:
        name = place_name(PLACE_ABBR.get(pl, pl))
        if not name:
            if len(pl) < 4:
                return "", "address formula without its place"
            name = text.split()[-1].strip(".,")
        head = "Schultheiss und Rat" if has_s else "Bürgermeister und Rat" if has_bm else "Rat"
        return f"{head} zu {name}", ""
    if has_s or has_r:
        return "", "address formula without its place"
    # "die von Thun", "zuo Thun", a place alone: the town as a body
    rest = [x for x in w if x not in ("die", "den", "dien", "der") and x not in PREP]
    if rest and len(rest) <= 2:
        name = place_name(PLACE_ABBR.get(" ".join(rest), " ".join(rest)), sure=True)
        if name:
            return f"die von {name}", ""
    return "", ""


# ------------------------------------------------------------------ candidates: places


def place_candidates(forms: list[str], geo_index: dict[str, list[dict]], sg_by: dict[str, list[dict]],
                     loci: bool = True) -> list[dict]:
    """St. Gallen register, HLS geography, Königsfelden and the SSRQ place database,
    each candidate with its names, ids and coordinates where the source has them.
    The SSRQ place search takes 5–15 s an answer, so it is asked only for spellings
    tagged at least twice (``loci``)."""
    out = []
    keys = {skey(f) for f in forms}
    for k in keys:
        for e in sg_by.get(k, []):
            if e["kind"] == "place":
                out.append({"src": "st-gallen", "sg": e["id"], "label": e["name"], "names": e["names"], "hls": e["hls"],
                            "ssrq": e["ssrq"], "geo": e.get("geo"), "settlement": e.get("ftype") == "P"})
        for g in geo_index.get(k, []):
            out.append({"src": "hls", "hls": g["id"], "label": g["title"], "names": [g["title"], base_name(g["title"])],
                        "geo": [g["lat"], g["lon"]] if g.get("lat") else None, "wikidata": g.get("wikidata"),
                        "geo_from": "wikidata" if g.get("wikidata") else None,
                        "settlement": any(SETTLEMENT_CLS.search(c) for c in g["cls"])})
    # close spellings in the HLS list (>= 85), as St. Gallen's «möglich»
    for f in forms[:2]:
        sf = skey(f)
        if len(sf) < 4:
            continue
        for gk, gs in geo_index.items():
            if gk not in keys and gk[:1] == sf[:1] and abs(len(gk) - len(sf)) <= 3 and fuzz.ratio(sf, gk) >= 85:
                for g in gs:
                    out.append({"src": "hls", "hls": g["id"], "label": g["title"], "names": [g["title"], base_name(g["title"])],
                                "geo": [g["lat"], g["lon"]] if g.get("lat") else None,
                                "settlement": any(SETTLEMENT_CLS.search(c) for c in g["cls"])})
    for f in forms[:2]:
        if len(key(f)) < 3:
            continue
        rows = cached(f"kf-places:{f}", lambda f=f: mcp_call("kf", "search_places", query=f, limit=20)) or []
        for r in rows[:8]:
            p = cached(f"kf-place:{r['id']}", lambda r=r: mcp_call("kf", "get_place", pid=r["id"]))
            geo = None
            if p and p.get("geo") and len(str(p["geo"]).split()) == 2:
                geo = [float(x) for x in str(p["geo"]).split()]
            names = [r.get("name_de") or "", r.get("name_fr") or ""] + [s.get("text") or "" for s in (p or {}).get("spans", [])[:30]]
            out.append({"src": "kf", "ssrq": r["id"], "label": r.get("name_de") or r["id"], "names": [n for n in names if n],
                        "hls": hls_id(r.get("hls_id")), "geo": geo, "region": r.get("region"),
                        "settlement": (r.get("place_type") or "") not in ("Gewässer", "Flur", "Berg")})
    if loci:
        out += loci_candidates(forms[:2])
    return out


def grade_places(forms: list[str], cands: list[dict]) -> list[dict]:
    """St. Gallen's two place rules, on candidates folded by HLS or SSRQ id:

    * name (scripts/auto_register.py grade_place): a name of the candidate is the
      spelling (folded) and it has an HLS article -> «wahrscheinlich» for the first
      such, settlements first, then the nearest to Thun; every other exact name,
      or a close spelling (>= 85; for Thun also with t/d, p/b, k/g as one),
      «möglich». (St. Gallen measured 74 % / 25 %.)
    * ssrq (scripts/ssrq_match.py grade_places): the spelling equals a name or an
      SSRQ spelling of exactly one settlement or territory -> «wahrscheinlich»,
      a close one (>= 85) «möglich». (93 % / 60 %.)

    A candidate both rules propose keeps the better grade. Never «sicher»."""
    fk = {skey(f) for f in forms} | {key(f) for f in forms}
    folded: list[dict] = []
    for c in cands:
        same = next((o for o in folded if (c.get("hls") and o.get("hls") == c.get("hls"))
                     or (c.get("ssrq") and o.get("ssrq") == c.get("ssrq"))
                     or (c.get("sg") and o.get("sg") == c.get("sg"))), None)
        if same:
            for f in ("hls", "ssrq", "sg", "gnd", "ortsnamen", "region", "type", "wikidata"):
                same[f] = same.get(f) or c.get(f)
            if not same.get("geo") and c.get("geo"):
                same["geo"], same["geo_from"] = c["geo"], c.get("geo_from") or c["src"]
            same["names"] = list(dict.fromkeys(same["names"] + c["names"]))
            same["srcs"] = sorted(set(same["srcs"]) | {c["src"]})
            same["settlement"] = same["settlement"] or c.get("settlement", False)
            if c["src"] == "ssrq":
                same["ssrq_settlement"] = c.get("settlement", False)
        else:
            folded.append({**c, "srcs": [c["src"]], "ssrq_settlement": c.get("settlement") if c["src"] == "ssrq" else None})
    for c in folded:
        names = {skey(n) for n in c["names"] if n} | {key(n) for n in c["names"] if n}
        c["exact"] = bool(fk & names)
        # the close spelling also with hard and soft consonants as one (Inderlappen ~ Interlaken,
        # Undersewen ~ Unterseen): a Thun addition, it only ever gives «möglich»
        c["score"] = 100 if c["exact"] else round(max((max(fuzz.ratio(skey(f), skey(n)), fuzz.ratio(lenis(skey(f)), lenis(skey(n))))
                                                      for f in forms for n in c["names"] if n), default=0))
        c["km"] = round(km(THUN, c["geo"])) if c.get("geo") else None
        c["grade"], c["rule"] = None, None
    # rule "name"
    exact = sorted([c for c in folded if c["exact"]], key=lambda c: (not c.get("hls"), not c["settlement"],
                                                                     c["km"] if c["km"] is not None else 1e9))
    for i, c in enumerate(exact):
        c["grade"], c["rule"] = ("wahrscheinlich" if i == 0 and c.get("hls") else "möglich"), "name"
    for c in folded:
        if not c["exact"] and c["score"] >= 85:
            c["grade"], c["rule"] = "möglich", "name"
    # rule "ssrq"
    ssrq_exact = [c for c in folded if "ssrq" in c["srcs"] and c["exact"] and c.get("ssrq_settlement")]
    for c in folded:
        if "ssrq" not in c["srcs"] or c["score"] < 85:
            continue
        g = "wahrscheinlich" if (c["exact"] and c.get("ssrq_settlement") and len(ssrq_exact) == 1) else "möglich"
        if c["grade"] is None or RANK[g] < RANK[c["grade"]]:
            c["grade"], c["rule"] = g, "ssrq"
    out = [c for c in folded if c["grade"]]
    out.sort(key=lambda c: (RANK[c["grade"]], -c["score"], not c["settlement"], c["km"] if c["km"] is not None else 1e9))
    return out[:4]


# ------------------------------------------------------------------ candidates: persons


def _surname(form: str) -> str:
    """sg-missiven-data ssrq_match._surname: the last word, a genitive or dative ending off."""
    w = [x for x in re.findall(r"[^\W\d_]+", form) if len(x) > 2]
    if not w:
        return ""
    s = w[-1]
    for suf in ("en", "in", "s"):
        if len(s) > 5 and s.endswith(suf):
            return s[: -len(suf)]
    return s


def hls_person_index(people: list[dict]) -> dict[str, list[dict]]:
    idx = collections.defaultdict(list)
    for p in people:
        fam = skey(p["family"])
        if fam:
            idx[fam.split()[-1][:3]].append(p)
    return idx


def person_candidates(forms: list[str], hidx, sg_people: list[dict]) -> list[dict]:
    out = []
    for form in forms[:2]:
        sn = _surname(form)
        if not sn:
            continue
        ssn = skey(sn)
        for p in hidx.get(ssn[:3], []):
            last = skey(p["family"]).split()[-1]
            if fuzz.ratio(ssn, last) < 80:
                continue
            name = flat(f"{p['first']} {p['family']}")
            out.append({"src": "hls", "hls": p["id"], "label": name, "name": name, "birth": p["birth"], "death": p["death"],
                        "score": round(fuzz.token_sort_ratio(skey(form), skey(name)))})
        # SSRQ persons by surname (sg-missiven-data ssrq_match.person_candidates)
        rows = cached(f"ssrqp:{sn}", lambda sn=sn: mcp_call("ssrq", "search_persons", query=sn, limit=50))
        rows = rows.get("result", rows) if isinstance(rows, dict) else rows
        for r in rows or []:
            std = r.get("std_name") or r.get("label") or ""
            sur = std.split()[-1] if std.split() else ""
            try:
                fns = [r.get("forename") or ""] + json.loads(r.get("orig_names") or "[]")
            except ValueError:
                fns = [r.get("forename") or ""]
            names = [std] + [f"{fn} {sur}" for fn in fns if fn and fn != "NN"]
            s = max(fuzz.token_sort_ratio(skey(form), skey(n)) for n in names)
            if s >= 82:
                out.append({"src": "ssrq", "ssrq": r["id"], "label": std, "score": round(s),
                            "first": r.get("first_year"), "last": r.get("last_year")})
        # Königsfelden: same id space as the SSRQ; attested years from its documents
        rows = cached(f"kfp:{sn}", lambda sn=sn: mcp_call("kf", "search_persons", query=sn, limit=50)) or []
        for r in rows:
            name = r.get("main_name") or flat(f"{r.get('forename', '')} {r.get('surname', '')}")
            s = round(fuzz.token_sort_ratio(skey(form), skey(name)))
            if s < 82:
                continue
            b, d = year_int(r.get("birth")), year_int(r.get("death"))
            first = last = None
            if s >= 90:
                ents = cached(f"kf-person-entries:{r['id']}", lambda r=r: mcp_call("kf", "get_entries_for_person", pid=r["id"], limit=50)) or []
                ys = [e["year"] for e in ents if isinstance(e.get("year"), int)]
                if ys:
                    first, last = min(ys), max(ys)
            out.append({"src": "kf", "ssrq": r["id"], "label": name, "score": s, "first": first or b, "last": last or d,
                        "hls": hls_id(r.get("hls_id")), "desc": r.get("occupation")})
        # St. Gallen's register: first attested in a dated letter
        for p in sg_people:
            if any(n.startswith("NN") or n.endswith(" NN") for n in p["names"]):
                continue  # "NN, Konrad": a forename without a person
            if not any(skey(n).split() and skey(n).split()[-1][:3] == ssn[:3] for n in p["names"]):
                continue
            s = max(fuzz.token_sort_ratio(skey(form), skey(n)) for n in p["names"])
            if s >= 82:
                out.append({"src": "st-gallen", "sg": p["id"], "label": p["name"], "score": round(s),
                            "first": p.get("first"), "last": p.get("first"), "hls": p.get("hls"), "ssrq": p.get("ssrq")})
    return out


def grade_persons(g: dict, cands: list[dict]) -> list[dict]:
    """St. Gallen's person rules.

    * name (HLS, life dates; scripts/auto_register.py grade_person): «sicher»
      forename and surname, spelling >= 95, the letters' years in the adult life,
      no rival within 5; «wahrscheinlich» >= 90, years fit, no rival;
      «möglich» >= 82, years fit. Without life dates: not proposed.
    * ssrq (SSRQ, Königsfelden, the St. Gallen register: years attested, not life
      dates; scripts/ssrq_match.py grade_persons): the letters within 40 years of
      the attested years; «wahrscheinlich» >= 95, no rival within 3; else «möglich».
      Never «sicher». Without attested years: not proposed («persons only within
      the years»)."""
    if not g.get("years"):
        return []
    y0, y1 = g["years"]
    fit = []
    for c in cands:
        if c["src"] == "hls":
            b, d = c.get("birth"), c.get("death")
            if not (b or d) or (b and y0 < b + 12) or (d and y1 > d + 3) or (b and not d and y1 > b + 90) or (d and not b and y0 < d - 80):
                continue
        else:
            f, la = c.get("first"), c.get("last") or c.get("first")
            if not f or not (f - 40 <= y1 and y0 <= la + 40):
                continue
        if c["score"] >= 82:
            fit.append(dict(c))
    # fold: one candidate per HLS or SSRQ id, the best score
    folded: list[dict] = []
    for c in sorted(fit, key=lambda c: -c["score"]):
        same = next((o for o in folded if (c.get("hls") and o.get("hls") == c.get("hls"))
                     or (c.get("ssrq") and o.get("ssrq") == c.get("ssrq"))
                     or (c.get("sg") and o.get("sg") == c.get("sg"))), None)
        if same:
            for f in ("hls", "ssrq", "sg", "birth", "death", "first", "last", "desc"):
                same[f] = same.get(f) or c.get(f)
            same["srcs"] = sorted(set(same["srcs"]) | {c["src"]})
            continue
        folded.append({**c, "srcs": [c["src"]]})
    two = len([w for w in g["key"].split() if w not in PARTICLES]) >= 2
    hls_c = [c for c in folded if "hls" in c["srcs"]]
    oth = [c for c in folded if "hls" not in c["srcs"]]
    for i, c in enumerate(hls_c):
        rivals = [r for r in hls_c if r is not c and r["score"] >= c["score"] - 5]
        if i == 0 and two and c["score"] >= 95 and not rivals:
            c["grade"] = "sicher"
        elif i == 0 and c["score"] >= 90 and not rivals:
            c["grade"] = "wahrscheinlich"
        else:
            c["grade"] = "möglich"
        c["rule"] = "name"
    for c in folded:
        if c in hls_c and c["grade"] != "möglich":
            continue
        if not any(s in c["srcs"] for s in ("ssrq", "kf", "st-gallen")):
            continue
        rival = any(o["score"] >= c["score"] - 3 for o in oth + hls_c if o is not c)
        g_ = "wahrscheinlich" if (c["score"] >= 95 and not rival) else "möglich"
        if c.get("grade") is None or RANK[g_] < RANK[c["grade"]]:
            c["grade"], c["rule"] = g_, ("ssrq" if ("ssrq" in c["srcs"] or "kf" in c["srcs"]) else "sg-register")
    if not two:  # a single name (a surname alone) is never more than «möglich» (a Thun addition)
        for c in folded:
            if c.get("grade") in ("sicher", "wahrscheinlich"):
                c["grade"] = "möglich"
    out = [c for c in folded if c.get("grade")]
    out.sort(key=lambda c: (RANK[c["grade"]], -c["score"]))
    return out[:4]


# ------------------------------------------------------------------ candidates: organisations


def org_candidates(name: str, forms: list[str], place_label: str | None, sg_orgs: list[dict],
                   variants: set[str] = frozenset()) -> list[dict]:
    """St. Gallen's register (exact folded name, or the same address formula), the
    SSRQ and Königsfelden organisations (the same body for the formula: name = the
    place, type = the formula's head)."""
    out = []
    head = name.rsplit(" zu ", 1)[0] if place_label and " zu " in name else ""
    same = {skey(name)} | {skey(f"{head} zu {v}") for v in variants if head}  # the same formula, another spelling of the place
    keys = same | {skey(f) for f in forms}
    ends = {skey(f" und Rat zu {v}") for v in variants} if head else set()
    for o in sg_orgs:
        hit = keys & {skey(n) for n in o["names"]}
        if not hit and ends and any(skey(o["name"]).endswith(e) for e in ends):
            # the same town's council under another head (St. Gallen: "Bürgermeister und Rat zu Thun")
            out.append({"src": "st-gallen", "sg": o["id"], "label": o["name"], "ssrq": o.get("ssrq"), "formula": False, "score": 90})
            continue
        if hit:
            out.append({"src": "st-gallen", "sg": o["id"], "label": o["name"], "ssrq": o.get("ssrq"),
                        "formula": skey(o["name"]) in same, "score": 100})
    if place_label:
        head = name.rsplit(" zu ", 1)[0] if " zu " in name else ""
        rows = cached(f"ssrqo-place:{place_label}", lambda: mcp_call("ssrq", "search_orgs", query=place_label, limit=30)) or []
        rows = rows.get("result", rows) if isinstance(rows, dict) else rows
        for r in rows:
            if skey(r.get("std_name") or "") != skey(place_label):
                continue
            t = (r.get("org_type") or "").split("/")[0]
            if head and t.startswith(head.split(" und ")[0]) and (" und " in head) == (" und " in t):
                out.append({"src": "ssrq", "ssrq": r["id"], "label": f"{r['std_name']} ({t})", "score": 100})
        rows = cached(f"kfo:{place_label}", lambda: mcp_call("kf", "search_orgs", query=place_label, limit=30)) or []
        for r in rows:
            if skey(r.get("name") or "") == skey(place_label) and head and (r.get("desc_de") or "") == head:
                out.append({"src": "kf", "ssrq": r["id"], "label": f"{r['name']} ({r['desc_de']})", "score": 100})
    else:
        for f in forms[:1]:
            rows = cached(f"ssrqo:{f}", lambda f=f: mcp_call("ssrq", "search_name_index", query=f, type_filter="org", limit=30))
            rows = rows.get("result", rows) if isinstance(rows, dict) else rows
            best: dict[str, dict] = {}
            for r in rows or []:
                s = fuzz.token_sort_ratio(skey(f), skey(r.get("name_text") or ""))
                if s >= 85 and s > best.get(r["ssrq_id"], {}).get("score", 0):
                    best[r["ssrq_id"]] = {"src": "ssrq", "ssrq": r["ssrq_id"], "label": r.get("label") or r.get("std_name"),
                                          "via": r.get("name_text"), "score": round(s)}
            out += sorted(best.values(), key=lambda c: -c["score"])[:2]
    return out


def grade_orgs(cands: list[dict]) -> list[dict]:
    """St. Gallen: an organisation is at most «möglich» (an item or an SSRQ name of
    exactly that name). Thun adds one rule of its own, not measured: the normalised
    address formula is the main name of a St. Gallen register entry ("Schultheiss
    und Rat zu Bern") -> «wahrscheinlich»."""
    folded: list[dict] = []
    for c in cands:
        same = next((o for o in folded if (c.get("ssrq") and o.get("ssrq") == c.get("ssrq"))
                     or (c.get("sg") and o.get("sg") == c.get("sg"))), None)
        if same:
            for f in ("ssrq", "sg"):
                same[f] = same.get(f) or c.get(f)
            same["formula"] = same.get("formula") or c.get("formula")
            same["srcs"] = sorted(set(same["srcs"]) | {c["src"]})
            if c["src"] == "st-gallen":
                same["label"] = c["label"]
            continue
        folded.append({**c, "srcs": [c["src"]]})
    for c in folded:
        c["grade"], c["rule"] = ("wahrscheinlich", "sg-formula") if c.get("formula") else ("möglich", "org")
    folded.sort(key=lambda c: (RANK[c["grade"]], -len(c["srcs"])))
    return folded[:3]


# ------------------------------------------------------------------ links of a candidate


def links_of(c: dict) -> list[dict]:
    out = []
    if c.get("sg"):
        out.append({"type": "st-gallen", "url": f"{SG_SITE}#/entry/{c['sg']}"})
    if c.get("hls"):
        out.append({"type": "hls", "url": f"https://hls-dhs-dss.ch/de/articles/{c['hls']}/"})
    sid = c.get("ssrq")
    if sid:
        if sid.startswith("loc"):
            out.append({"type": "ssrq", "url": f"{LOCI}/views/view-place.xq?id={sid}"})
        else:
            out.append({"type": "ssrq", "url": f"https://www.ssrq-sds-fds.ch/persons-db-edit/?query={sid}"})
    if c.get("ssrq") and "kf" in c.get("srcs", []):
        kind = "places" if sid.startswith("loc") else "orgs" if sid.startswith("org") else "persons"
        out.append({"type": "kf", "url": f"https://www.koenigsfelden.uzh.ch/{kind}/{sid}"})
    if c.get("wikidata"):
        out.append({"type": "wikidata", "url": f"https://www.wikidata.org/wiki/{c['wikidata']}"})
    if c.get("gnd"):
        out.append({"type": "gnd", "url": f"https://d-nb.info/gnd/{c['gnd']}"})
    if c.get("ortsnamen"):
        out.append({"type": "ortsnamen", "url": f"https://search.ortsnamen.ch/record/{c['ortsnamen']}"})
    return out


def slim(c: dict, kind: str) -> dict:
    keep = ("label", "grade", "rule", "score", "srcs", "hls", "ssrq", "sg", "birth", "death", "first", "last", "km", "geo",
            "geo_from", "wikidata", "region", "type", "desc", "via")
    out = {k: c[k] for k in keep if c.get(k) not in (None, "", [])}
    out["links"] = links_of(c)
    return out


# ------------------------------------------------------------------ Wikidata coordinates by HLS id


def wd_coords(hls_ids: list[str]) -> dict[str, list[float]]:
    """P902 (HLS id) -> P625 through the Query Service, 150 ids a query, one query
    at a time; St. Gallen's search API route met 429 (docs/REGISTER.md there)."""
    out = {}
    todo = sorted(set(hls_ids))
    for i in range(0, len(todo), 150):
        part = todo[i:i + 150]

        def ask(part=part):
            values = " ".join(f'"{h}"' for h in part)
            q = f"SELECT ?h ?c ?i WHERE {{ VALUES ?h {{ {values} }} ?i wdt:P902 ?h ; wdt:P625 ?c . }}"
            body = urllib.parse.urlencode({"query": q}).encode()
            txt = http_get(WDQS, body, {"Accept": "application/sparql-results+json",
                                        "Content-Type": "application/x-www-form-urlencoded"}, gap=2.0)
            res = {}
            for b in json.loads(txt)["results"]["bindings"]:
                m = re.match(r"Point\(([-\d.eE]+) ([-\d.eE]+)\)", b["c"]["value"])
                if m and b["h"]["value"] not in res:
                    res[b["h"]["value"]] = [round(float(m.group(2)), 5), round(float(m.group(1)), 5),
                                            b["i"]["value"].rsplit("/", 1)[1]]
            return res
        out.update(cached("wd-coords:" + "|".join(part), ask))
    return out


# ------------------------------------------------------------------ the build


def eid(prefix: str, k: str) -> str:
    return f"{prefix}-{hashlib.sha1(k.encode()).hexdigest()[:8]}"


def entry_shell(kind: str, ms: list[dict], k: str) -> dict:
    forms = collections.Counter(m["text"] for m in ms)
    letters = sorted({x for m in ms for x in m["letters"]})
    years = sorted({m["year"] for m in ms if m["year"]})
    roles = collections.Counter(m["role"] for m in ms if m["role"])
    return {"kind": kind, "key": k, "name": forms.most_common(1)[0][0], "auto": True,
            "forms": [[f, n] for f, n in forms.most_common()], "mentions": len(ms), "letters": letters,
            "pages": sorted({m["page"] for m in ms}), "years": [years[0], years[-1]] if years else None,
            "roles": dict(roles), "sg_tag_refs": dict(collections.Counter(m["ref"] for m in ms if m.get("ref"))),
            "occ": [[m["page"], m["start"], m["end"]] for m in ms]}


def group_places(ms: list[dict]) -> dict[str, list[dict]]:
    by = collections.defaultdict(list)
    for m in ms:
        k = skey(m["text"])
        if len(k) >= 3 and not any(ch.isdigit() for ch in k):
            by[k].append(m)
    # a trailing inflection joins its stem: berne -> bern, thuno -> thun
    for k in sorted(by, key=len, reverse=True):
        for suf in ("en", "e", "n", "o", "s"):
            st = k[: -len(suf)]
            if k.endswith(suf) and len(st) >= 3 and st in by and st != k:
                by[st] += by.pop(k)
                break
    return by


def group_persons(ms: list[dict], fn: set[str]) -> tuple[list[tuple[str, list[dict]]], collections.Counter]:
    why = collections.Counter()
    by = collections.defaultdict(list)
    for m in ms:
        k, w = norm_person(m["text"], fn)
        if w:
            why[w] += 1
            continue
        by[k].append(m)
    # spellings that agree (>= 90) are one name: each spelling, most frequent first,
    # joins the first name whose most frequent spelling it agrees with (no chains);
    # the whole name and the surname alone must agree, so that a shared forename
    # does not carry two surnames together (Schopfer, Scherer)
    heads: dict[str, list[str]] = collections.defaultdict(list)
    names: dict[str, list[dict]] = {}
    for k in sorted(by, key=lambda k: (-len(by[k]), k)):
        n = len(k.split())
        hit = next((h for h in heads[(k.split()[-1][:2], n)]
                    if fuzz.token_sort_ratio(h, k) >= 90 and fuzz.ratio(h.split()[-1], k.split()[-1]) >= 85), None)
        if hit:
            names[hit] += by[k]
        else:
            heads[(k.split()[-1][:2], n)].append(k)
            names[k] = list(by[k])
    # time: a person's letters lie within 30 years of the first; undated mentions join a lone entry
    out = []
    for k, group in names.items():
        dated = sorted([m for m in group if m["year"]], key=lambda m: m["year"])
        undated = [m for m in group if not m["year"]]
        clusters: list[list[dict]] = []
        for m in dated:
            if clusters and m["year"] - clusters[-1][0]["year"] <= 30:
                clusters[-1].append(m)
            else:
                clusters.append([m])
        if undated:
            if len(clusters) == 1:
                clusters[0] += undated
            else:
                clusters.append(undated)
        for c in clusters:
            out.append((k, c))
    return out, why


def build(workers: int, sg: str | None, kinds: set[str]) -> None:
    ms = mentions()
    print(f"{len(ms)} tagged names", flush=True)
    sg_reg = sg_registers(sg)
    sg_by = collections.defaultdict(list)
    for e in sg_reg.values():
        for n in e["names"]:
            sg_by[skey(n)].append(e)
    geo = hls_geo()
    have = {g["id"] for g in geo}
    geo_wd = [g for g in hls_wd_places() if g["id"] not in have]
    print(f"HLS places on Wikidata that our HLS server lacks: {len(geo_wd)}", flush=True)
    geo = geo + geo_wd
    geo_index = collections.defaultdict(list)
    for g in geo:
        for n in {g["title"], base_name(g["title"])}:
            geo_index[skey(n)].append(g)
    people = hls_persons()
    print(f"St. Gallen register {len(sg_reg)}, HLS geography {len(geo)}, HLS persons {len(people)}", flush=True)
    today = dt.date.today().isoformat()

    # ---------------- places
    place_ms = [m for m in ms if m["type"] == "place"]
    pg = group_places(place_ms)
    fn = forenames(sg_reg, people)
    why_place = collections.Counter()
    for k in list(pg):  # a forename tagged as a place (Clewi, Uelli)
        if all(stem_forename(w, fn) for w in key(pg[k][0]["text"]).split()) and k not in geo_index and k not in sg_by:
            why_place["forename"] += len(pg.pop(k))
    print(f"places: {len(pg)} spellings; dropped {dict(why_place)}", flush=True)

    def one_place(k):
        forms = [f for f, _ in collections.Counter(m["text"] for m in pg[k]).most_common(2)]
        try:
            return k, place_candidates(forms, geo_index, sg_by, loci=len(pg[k]) >= 2)
        except Exception as exc:  # noqa: BLE001
            print(f"  failed {forms}: {exc}", file=sys.stderr, flush=True)
            return k, None
    raw: dict[str, list[dict]] = {}
    with cf.ThreadPoolExecutor(workers) as ex:
        for i, (k, c) in enumerate(ex.map(one_place, sorted(pg, key=lambda k: -len(pg[k]))), 1):
            if c is not None:
                raw[k] = c
            if i % 100 == 0:
                print(f"  places {i}/{len(pg)}", flush=True)
    failed_places = len(pg) - len(raw)
    # coordinates for candidates with an HLS id and none of their own
    need = [c["hls"] for cs in raw.values() for c in cs if c.get("hls") and not c.get("geo")]
    coords = wd_coords(need)
    for cs in raw.values():
        for c in cs:
            if not c.get("geo") and c.get("hls") in coords:
                lat, lon, qid = coords[c["hls"]]
                c["geo"], c["wikidata"] = [lat, lon], qid
                c["geo_from"] = "wikidata"
    places: dict[str, dict] = {}
    by_auth: dict[str, str] = {}
    for k in sorted(raw, key=lambda k: -len(pg[k])):
        forms = [f for f, _ in collections.Counter(m["text"] for m in pg[k]).most_common(2)]
        cands = grade_places(forms, raw[k])
        top = cands[0] if cands else None
        auth = None
        if top and top["grade"] == "wahrscheinlich":
            auth = f"hls:{top['hls']}" if top.get("hls") else f"ssrq:{top.get('ssrq')}"
        if auth and auth in by_auth:  # the same settlement: one entry
            e = places[by_auth[auth]]
            e["_ms"] += pg[k]
            continue
        e = {"_ms": list(pg[k]), "_cands": cands, "_k": k}
        pid = eid("pl", k)
        places[pid] = e
        if auth:
            by_auth[auth] = pid
    place_name_of: dict[str, str] = {}
    out_places = {}
    for pid, e in places.items():
        x = entry_shell("place", e["_ms"], e["_k"])
        cands = e["_cands"]
        top = cands[0] if cands else None
        if top and top["grade"] == "wahrscheinlich":
            x["name"] = base_name(top["label"]) if top.get("src") == "hls" and "hls" in top["srcs"] and len(top["srcs"]) == 1 else top["label"]
            x["name"] = base_name(x["name"])
        x["candidates"] = [slim(c, "place") for c in cands]
        geo_c = next((c for c in cands if c.get("geo")), None) if top else None
        if top and top.get("geo"):
            x["geo"] = top["geo"]
            x["geo_grade"] = top["grade"]
            x["geo_from"] = top.get("geo_from") or top.get("src") or "hls"
        elif geo_c is None and top:
            x["no_geo"] = "best candidate without coordinates"
        else:
            x["no_geo"] = "no candidate" if not top else "best candidate without coordinates"
        out_places[pid] = x
        for m in e["_ms"]:
            place_name_of.setdefault(skey(m["text"]), x["name"])
            place_name_of.setdefault(key(m["text"]), x["name"])

    sure_places = {x["name"] for x in out_places.values() if x["candidates"] and x["candidates"][0]["grade"] == "wahrscheinlich"}
    place_variants: dict[str, set[str]] = collections.defaultdict(set)
    for x in out_places.values():
        place_variants[x["name"]] |= {f for f, _ in x["forms"][:6]} | {base_name(c["label"]) for c in x["candidates"][:1]}
    frequent = {skey(m["text"]): out_places[pid]["name"] for pid, e in places.items() for m in e["_ms"]
                if len(e["_ms"]) >= 3}

    def place_name(text_key: str, sure: bool = False) -> str | None:
        hit = place_name_of.get(skey(text_key)) or place_name_of.get(text_key)
        if sure:  # only a place whose best candidate is «wahrscheinlich»
            return hit if hit in sure_places else None
        if hit:
            return hit
        k = lenis(skey(text_key))  # Solotorn ~ Solottern: a close spelling of a frequent place
        best = max(((fuzz.ratio(k, lenis(f)), n) for f, n in frequent.items() if f[:1] == k[:1]), default=(0, None))
        return best[1] if best[0] >= 88 else None

    # ---------------- organisations
    org_ms = [m for m in ms if m["type"] == "org"]
    why_org = collections.Counter()
    og = collections.defaultdict(list)
    for m in org_ms:
        name, w = org_formula(m["text"], place_name)
        if w:
            why_org[w] += 1
            continue
        og[name or "~" + skey(m["text"])].append(m)
    # "Rat zu X" and "die von X" fold into "Schultheiss und Rat zu X" where that body is named
    for k in list(og):
        for pre in ("Rat zu ", "die von "):
            if k.startswith(pre):
                tgt = "Schultheiss und Rat zu " + k[len(pre):]
                if tgt in og and tgt != k:
                    og[tgt] += og.pop(k)
                    break
    # other names: spellings that agree (>= 92)
    loose = sorted([k for k in og if k.startswith("~")], key=lambda k: -len(og[k]))
    for i, a in enumerate(loose):
        if a not in og:
            continue
        for b in loose[i + 1:]:
            if b in og and fuzz.ratio(lenis(a[1:]), lenis(b[1:])) >= 90:
                og[a] += og.pop(b)
    sg_orgs = [e for e in sg_reg.values() if e["kind"] == "org"]
    print(f"organisations: {len(og)} names", flush=True)

    def one_org(k):
        ms_ = og[k]
        forms = [f for f, _ in collections.Counter(m["text"] for m in ms_).most_common(2)]
        name = k if not k.startswith("~") else forms[0]
        pl = k.rsplit(" zu ", 1)[1] if " zu " in k and not k.startswith("~") else None
        try:
            return k, grade_orgs(org_candidates(name, forms, pl, sg_orgs, place_variants.get(pl, set()) if pl else set()))
        except Exception as exc:  # noqa: BLE001
            print(f"  failed {name}: {exc}", file=sys.stderr, flush=True)
            return k, None
    out_orgs = {}
    failed_orgs = 0
    if "org" in kinds:
        with cf.ThreadPoolExecutor(workers) as ex:
            for k, cands in ex.map(one_org, sorted(og, key=lambda k: -len(og[k]))):
                if cands is None:
                    failed_orgs += 1
                    continue
                x = entry_shell("org", og[k], k)
                if not k.startswith("~"):
                    x["name"] = k
                    x["normalised"] = True
                x["candidates"] = [slim(c, "org") for c in cands]
                out_orgs[eid("org", k)] = x

    # ---------------- persons
    per_ms = [m for m in ms if m["type"] == "per"]
    place_keys = {skey(m["text"]) for m in place_ms if len(pg.get(skey(m["text"]), [])) >= 2} | \
                 {e["key"] for e in out_places.values() if e["candidates"]}
    kept = []
    why_per = collections.Counter()
    for m in per_ms:
        if skey(m["text"]) in place_keys or key(m["text"]) in place_keys:
            why_per["a place name"] += 1
            continue
        kept.append(m)
    persons, why2 = group_persons(kept, fn)
    why_per.update(why2)
    sg_people = [e for e in sg_reg.values() if e["kind"] == "person"]
    hidx = hls_person_index(people)
    print(f"persons: {len(persons)} entries", flush=True)

    def one_person(item):
        k, ms_ = item
        x = entry_shell("person", ms_, k)
        forms = [f for f, _ in collections.Counter(m["text"] for m in ms_).most_common(2)]
        try:
            cands = person_candidates(forms, hidx, sg_people) if x["years"] else []
            return k, x, grade_persons({"key": k, "years": x["years"]}, cands)
        except Exception as exc:  # noqa: BLE001
            print(f"  failed {forms}: {exc}", file=sys.stderr, flush=True)
            return k, x, None
    out_persons = {}
    failed_persons = 0
    if "per" in kinds:
        with cf.ThreadPoolExecutor(workers) as ex:
            for i, (k, x, cands) in enumerate(ex.map(one_person, persons), 1):
                if cands is None:
                    failed_persons += 1
                    continue
                x["candidates"] = [slim(c, "person") for c in cands]
                pid = eid("per", f"{k}|{x['years'][0] if x['years'] else 'undated'}")
                while pid in out_persons:
                    pid = eid("per", pid)
                out_persons[pid] = x
                if i % 500 == 0:
                    print(f"  persons {i}/{len(persons)}", flush=True)

    def counts(d):
        c = collections.Counter(e["candidates"][0]["grade"] if e["candidates"] else "none" for e in d.values())
        return {g: c.get(g, 0) for g in (*GRADES, "none")}

    def src_counts(d):
        c = collections.Counter()
        for e in d.values():
            for cand in e["candidates"][:1]:
                for s in cand.get("srcs", []):
                    c[f"{s}/{cand['grade']}"] += 1
        return dict(sorted(c.items()))

    common = {"date": today, "reader": READER, "measured": MEASURED,
              "about": "Generated automatically from the automatic tagging (St. Gallen's combined tagger on the Gemini 4 "
                       "Argon reading: hmBERT and qwen3.8 propose, gpt-oss-120b decides; not measured on Thun) by scripts/register.py. No entry and no link is checked by "
                       "a person; every link is a proposal graded sicher / wahrscheinlich / möglich by St. Gallen's rules "
                       "(docs/REGISTER.md). occ: [page, start, end] of each tagged mention."}
    OUT.mkdir(exist_ok=True)
    if "place" in kinds:
        geo_n = sum(1 for e in out_places.values() if e.get("geo") and e["geo_grade"] == "wahrscheinlich")
        (OUT / "places.json").write_text(json.dumps({
            **common, "rules": grade_places.__doc__, "counts": counts(out_places), "by_source": src_counts(out_places),
            "dropped": dict(why_place),
            "with_coordinates": {"wahrscheinlich": geo_n,
                                 "möglich": sum(1 for e in out_places.values() if e.get("geo") and e["geo_grade"] == "möglich")},
            "failed": failed_places, "entries": out_places}, ensure_ascii=False, indent=0), encoding="utf-8")
        print(f"places: {len(out_places)} entries, {counts(out_places)}, {geo_n} with coordinates (wahrscheinlich)", flush=True)
    if "org" in kinds:
        (OUT / "orgs.json").write_text(json.dumps({
            **common, "rules": grade_orgs.__doc__, "counts": counts(out_orgs), "by_source": src_counts(out_orgs),
            "dropped": dict(why_org), "failed": failed_orgs, "entries": out_orgs}, ensure_ascii=False, indent=0), encoding="utf-8")
        print(f"organisations: {len(out_orgs)} entries, {counts(out_orgs)}; dropped {dict(why_org)}", flush=True)
    if "per" in kinds:
        (OUT / "persons.json").write_text(json.dumps({
            **common, "rules": grade_persons.__doc__, "counts": counts(out_persons), "by_source": src_counts(out_persons),
            "dropped": dict(why_per), "failed": failed_persons, "entries": out_persons}, ensure_ascii=False, indent=0),
            encoding="utf-8")
        print(f"persons: {len(out_persons)} entries, {counts(out_persons)}; dropped {dict(why_per)}", flush=True)
    write_sg_links(sg, out_places, out_orgs, out_persons, sg_reg)


def write_sg_links(sg, places, orgs, persons, sg_reg) -> None:
    """links/registers/st-gallen.json: Thun entries whose candidates name an entry
    of the St. Gallen register, or (places) whose best candidate's HLS article is
    the best candidate of a St. Gallen generated entry. Thun side only."""
    auto = sg_auto(sg)
    by_hls = collections.defaultdict(list)
    for aid, a in auto.items():
        c = (a.get("candidates") or [None])[0]
        if c and c.get("hls") and c.get("grade") in ("sicher", "wahrscheinlich"):
            by_hls[(a["kind"], c["hls"])].append(aid)
    rows = []
    for d in (places, orgs, persons):
        for tid, e in d.items():
            for c in e["candidates"]:
                if c.get("sg"):
                    rows.append({"entry": tid, "kind": e["kind"], "name": e["name"], "other": c["sg"],
                                 "label": sg_reg.get(c["sg"], {}).get("name", c["sg"]), "how": "register", "grade": c["grade"]})
            top = (e["candidates"] or [None])[0]
            if top and top.get("hls") and top["grade"] in ("sicher", "wahrscheinlich"):
                for aid in by_hls.get((e["kind"], top["hls"]), [])[:3]:
                    rows.append({"entry": tid, "kind": e["kind"], "name": e["name"], "other": aid,
                                 "label": auto[aid]["name"], "how": "same HLS article", "grade": top["grade"]})
    path = ROOT / "links" / "registers" / "st-gallen.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        "about": "Register entries of the Thun Missives that name an entry of the St. Gallen Missives register (the "
                 "edition's, or one generated there whose best candidate is the same HLS article). Automatic, "
                 "unchecked; grade = the Thun candidate's grade. Thun side only (scripts/register.py).",
        "viewer": SG_SITE, "date": dt.date.today().isoformat(), "links": rows}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"links/registers/st-gallen.json: {len(rows)} links", flush=True)


def cmd_groups(sg: str | None) -> None:
    ms = mentions()
    sg_reg = sg_registers(sg)
    fn = forenames(sg_reg, hls_persons())
    pg = group_places([m for m in ms if m["type"] == "place"])
    persons, why = group_persons([m for m in ms if m["type"] == "per"], fn)
    print(f"places: {len(pg)} spellings; persons: {len(persons)} entries; dropped {dict(why)}")
    for k, g in sorted(pg.items(), key=lambda x: -len(x[1]))[:25]:
        print("  place", len(g), k, sorted({m["text"] for m in g})[:6])
    for k, g in sorted(persons, key=lambda x: -len(x[1]))[:25]:
        ys = sorted({m["year"] for m in g if m["year"]})
        print("  person", len(g), k, ys[:1] + ys[-1:], sorted({m["text"] for m in g})[:5])


def cmd_docs() -> None:
    """docs/places_without_coordinates.md from registers/places.json (as St. Gallen's)."""
    d = json.loads((OUT / "places.json").read_text())
    es = d["entries"]
    miss = sorted(((k, e) for k, e in es.items() if not (e.get("geo") and e.get("geo_grade") == "wahrscheinlich")),
                  key=lambda x: (-len(x[1]["letters"]), x[1]["name"]))
    poss = sum(1 for _, e in miss if e.get("geo"))
    lines = ["# Places without coordinates", "",
             f"{len(miss)} of {len(es)} places of the generated register (`registers/places.json`, {d['date']}) are not on "
             f"the overview map: they have no candidate graded «wahrscheinlich» with coordinates. {poss} of them have "
             "coordinates from a «möglich» candidate (the map shows those only on request). Sorted by the number of letters. "
             "Written by `scripts/register.py docs`; do not edit by hand.", "",
             "Coordinates come only from a matched candidate (St. Gallen register, Königsfelden, HLS, or Wikidata by "
             "the candidate's HLS id), never from a name alone.", "",
             "| Entry | Name | Spellings | Letters | Best candidate | Grade | Why not on the map |",
             "|---|---|---|---:|---|---|---|"]
    for k, e in miss:
        c = (e["candidates"] or [None])[0]
        why = ("coordinates only from a «möglich» candidate" if e.get("geo") else
               "no candidate" if not c else "best candidate has no coordinates")
        cell = lambda t: str(t).replace("|", "/")  # noqa: E731
        lines.append(f"| `{k}` | {cell(e['name'])} | {cell(', '.join(f for f, _ in e['forms'][:4]))} | {len(e['letters'])} | "
                     f"{cell(c['label']) if c else '—'} | {c['grade'] if c else '—'} | {why} |")
    (ROOT / "docs" / "places_without_coordinates.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"docs/places_without_coordinates.md: {len(miss)} places")


def cmd_sample(n: int, seed: int) -> None:
    """A random draw of place and person entries with a candidate, for the spot check."""
    rnd = random.Random(seed)
    for f in ("places", "persons"):
        d = json.loads((OUT / f"{f}.json").read_text())["entries"]
        pool = sorted(k for k, e in d.items() if e["candidates"])
        for k in rnd.sample(pool, min(n, len(pool))):
            e = d[k]
            c = e["candidates"][0]
            print("\t".join(str(x) for x in (f, k, e["name"], "|".join(f for f, _ in e["forms"][:4]), e["years"],
                                               ",".join(e["letters"][:3]), c["grade"], c["rule"], c["label"],
                                               c.get("km", ""), c.get("birth", c.get("first", "")), c.get("death", c.get("last", "")),
                                               " ".join(l["url"] for l in c["links"]))))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["groups", "link", "docs", "sample"])
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--sg", help="a local checkout of DHBern/sg-missiven-data (default: fetched from GitHub)")
    ap.add_argument("--only", default="place,org,per")
    ap.add_argument("--n", type=int, default=30)
    ap.add_argument("--seed", type=int, default=17112026)
    a = ap.parse_args()
    if a.cmd == "groups":
        cmd_groups(a.sg)
    elif a.cmd == "sample":
        cmd_sample(a.n, a.seed)
    elif a.cmd == "docs":
        cmd_docs()
    else:
        build(a.workers, a.sg, set(a.only.split(",")))


if __name__ == "__main__":
    main()
