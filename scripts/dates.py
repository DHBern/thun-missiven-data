"""Date every letter from its date line: the year, and the day where the line gives one.

    python scripts/dates.py            # -> dates/dates.jsonl, and a summary

The date line is the one the regest draft quotes (`date_text` in
regests/drafts.jsonl, read from the best reading: Gemini 4 Argon for nearly
every letter). Nothing is taken from the model's own year or date: both are
read here again, by rule.

**Year.** Written out ("m cccc xxxvij", "1442", "xvC xij") it is taken as it
stands. Abbreviated ("anno etc. xxxix", "lxxxxj", "xlmo") it needs a century:
the one of the letters around it in the same volume that write their year in
full (the volumes are numbered roughly in order of time), else the 15th
century, where most of the Thun letters belong. A year so closed is marked
``century: "neighbours"`` or ``"default"``.

**Day.**
- In figures: "xvi die mensis maii", "uff 7 tag mertzen", "den 7. februarij",
  "octava die maij", "ultima die mensis augusti", "xxi octobris".
- By the church year: a feast ("sant Martins tag", "Lucie", "assumpcionis
  Marie"), its eve ("abent", "vigilia"), or a weekday before or after it
  ("donrstag nach Andree", "feria quarta post Lucie", "sabato ante Judica",
  "zinstag nach misericordia domini"). Fixed feasts from the calendar below,
  movable ones from Easter (Julian computus).

The day is a **Julian** date, as the writer counted it (Bern kept the Julian
calendar until 1701); ``weekday`` is computed in the same calendar. Bern began
the year at Christmas: a letter dated 25–31 December "anno 1440" was written
in December 1439 by our count; such a letter is marked
``year_start: "christmas?"`` and its year is not changed.

Every result says how it was found (``how``), so that a reader can tell a
computed feast-day date from one the writer gave in figures. Nothing here is
checked by a person.
"""

from __future__ import annotations

import csv
import json
import re
import statistics
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# ── calendar ────────────────────────────────────────────────────────────────

def jdn(y: int, m: int, d: int) -> int:
    """Julian day number of a date in the Julian calendar."""
    a = (14 - m) // 12
    yy = y + 4800 - a
    mm = m + 12 * a - 3
    return d + (153 * mm + 2) // 5 + 365 * yy + yy // 4 - 32083


def from_jdn(j: int) -> tuple[int, int, int]:
    c = j + 32082
    d = (4 * c + 3) // 1461
    e = c - 1461 * d // 4
    m = (5 * e + 2) // 153
    return d - 4800 + m // 10, m + 3 - 12 * (m // 10), e - (153 * m + 2) // 5 + 1


def weekday(j: int) -> int:
    """0 = Monday … 6 = Sunday."""
    return j % 7


def easter(y: int) -> int:
    """Easter Sunday in the Julian calendar, as a JDN."""
    a, b, c = y % 4, y % 7, y % 19
    d = (19 * c + 15) % 30
    e = (2 * a + 4 * b - d + 34) % 7
    m = (d + e + 114) // 31
    day = (d + e + 114) % 31 + 1
    return jdn(y, m, day)


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s.lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.replace("ſ", "s").replace("ß", "ss").replace("ÿ", "y")
    s = re.sub(r"ꝫ\s*c\s*ꝭ?|ꝛc", " etc ", s)
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    s = re.sub(r"\bf(?:i|r)?a\b", "feria", s)
    for a, b in (("qrta", "quarta"), ("qnta", "quinta"), ("sta", "sexta"), ("sesta", "sexta"),
                 ("tcia", "tercia"), ("scda", "secunda"), ("sda", "secunda")):
        s = re.sub(rf"\b{a}\b", b, s)
    return s


def feastform(s: str) -> str:
    """For matching feasts and weekdays only: u for v, t for c before -io-."""
    return re.sub(r"ci(?=o)", "ti", s.replace("v", "u").replace("j", "i"))


def pform(pat: str) -> str:
    """A pattern in the feast form (outside lookaheads and character classes it is plain text)."""
    return pat.replace("v", "u").replace("j", "i")


# fixed feasts (Konstanz/Lausanne usage, the common ones in Bernese letters): pattern -> (month, day)
FIXED = [
    (r"circumcision|nuw(?:en)? jar|niiw jar|jars tag", (1, 1)),
    (r"epiphan|dri(?:er)? (?:heilig(?:en)? )?kun|drei konig|zwolften|obersten tag|ebenwich", (1, 6)),
    (r"hilari|hilor", (1, 13)),
    (r"felicis in pincis", (1, 14)),
    (r"anthon|antoni", (1, 17)),
    (r"sebastian|fabian", (1, 20)),
    (r"agnes|agnet", (1, 21)),
    (r"vincen", (1, 22)),
    (r"conversion|bekerd|bekerung", (1, 25)),
    (r"liechtmess|lichtmess|purification|candel", (2, 2)),
    (r"blasi", (2, 3)),
    (r"agath|agten", (2, 5)),
    (r"doroth", (2, 6)),
    (r"valentin", (2, 14)),
    (r"kathedra|cathedra|stulfeier|stuhlfeier", (2, 22)),
    (r"matthi|mathi[ae]", (2, 24)),
    (r"gregor", (3, 12)),
    (r"gertrud", (3, 17)),
    (r"benedict|benedikt", (3, 21)),
    (r"annunciation|verkund", (3, 25)),
    (r"ambros", (4, 4)),
    (r"georg|jorg|jerg|gor[gy]en|goer[gy]", (4, 23)),
    (r"marc[iey]|markus|marx", (4, 25)),
    (r"philipp|walpurg|meyen tag|maien tag", (5, 1)),
    (r"inventio|[kc]ru[t]?z\\w* (?:tag )?(?:ze|im) mey|crucis.*maij", (5, 3)),
    (r"pancra", (5, 12)),
    (r"urban", (5, 25)),
    (r"bonifaci", (6, 5)),
    (r"vit[ie]? |viti|modesti", (6, 15)),
    (r"zehen ?tusent ritter|x(?:m|tusent) ritter|10000 ritter|decem milium", (6, 22)),
    (r"(?:johann|johans|joh)\w* (?:des )?(?:baptist|bap|toufer|teuf)|sungicht|sunwend|nativitat\w* (?:sancti )?johann", (6, 24)),
    (r"peter und paul|petri et pauli|petri und pauli|apostolorum petri", (6, 29)),
    (r"visitation|heimsuch", (7, 2)),
    (r"ulrich|uolrich|udalric|ulric", (7, 4)),
    (r"margareth|margret", (7, 13)),
    (r"(?:maria |marien )?magdalen", (7, 22)),
    (r"jacob|jakob|jacobi", (7, 25)),
    (r"anna[e ]|sant annen|anne tag|\\banne\\b", (7, 26)),
    (r"petri ad vincula|vincula petri|peters? (?:tag )?ze ougst|petri kettenfeier", (8, 1)),
    (r"oswald", (8, 5)),
    (r"(?:sixt|affer|afra)", (8, 7)),
    (r"lauren[ct]|lorentz|lorenz", (8, 10)),
    (r"assumption|himelfart (?:unser|marie)|unser (?:lieben )?frowen tag (?:ze|im) ougst|frowen tag der (?:erren|ersten)", (8, 15)),
    (r"bartholom|bartlom", (8, 24)),
    (r"augustin", (8, 28)),
    (r"decollation|enthoupt", (8, 29)),
    (r"veren|\\bfrenen?\\b", (9, 1)),
    (r"nativitat\w* (?:beat\w* )?mari|unser (?:lieben )?frowen tag (?:ze|im) herpst|frowen tag der (?:jungern|letsten)", (9, 8)),
    (r"exalta|crucis exalt|kruz(?:es)? (?:tag )?(?:ze|im) herpst|helig(?:en)? cruc(?:es|is) tag|crutz tag", (9, 14)),
    (r"matthe|matheus|mathei|mathej|matthej", (9, 21)),
    (r"mauri[tc]i|moritz", (9, 22)),
    (r"michel|michael|michahel", (9, 29)),
    (r"leodegar|leutgar|liggaris", (10, 2)),
    (r"francisc|franzisc", (10, 4)),
    (r"gall[ie]|galle?n", (10, 16)),
    (r"luc(?:e|as|ae) ev|lucas|luce ewang|sant lux|\\bluce\\b", (10, 18)),
    (r"xi ?m(?:ill)?\w* (?:megd|maged|jungfr|virgin)|elf ?tusent|11000|undecim milium", (10, 21)),
    (r"simon\w*(?: et| und)? jud|simonis", (10, 28)),
    (r"aller (?:heilig|helg)|omnium sanctorum", (11, 1)),
    (r"aller (?:selen|seel)|animarum", (11, 2)),
    (r"martin", (11, 11)),
    (r"othmar|otmar", (11, 16)),
    (r"elisabeth|elsbeth", (11, 19)),
    (r"cecili|cecil", (11, 22)),
    (r"clement", (11, 23)),
    (r"katherin|katharin|catherin|katrin", (11, 25)),
    (r"conrad|cuonrad|konrad", (11, 26)),
    (r"andre", (11, 30)),
    (r"barbar", (12, 4)),
    (r"nicla|nikla|nicola|niclaus|niclaws", (12, 6)),
    (r"concepti|empfengn", (12, 8)),
    (r"luci[ae]|lucie", (12, 13)),
    (r"thom(?:as|e)", (12, 21)),
    (r"wienacht|winacht|nativitat\w* (?:domini|christi)|heilig(?:en)? tag ze wienacht", (12, 25)),
    (r"stephan|steffan", (12, 26)),
    (r"johann\w* (?:ev|des ev|ewang)|sant johans tag ze wienacht", (12, 27)),
    (r"kindlin|unschuld|innocent", (12, 28)),
    (r"silvest", (12, 31)),
]
# movable feasts: pattern -> days from Easter Sunday
MOVABLE = [
    (r"septuages", -63), (r"sexages", -56), (r"esto mihi|herren fasnacht|pfaffen fasnacht", -49),
    (r"ascher|aschermitwoch|cinerum", -46), (r"(?:alt\\w*|buren|bur) ?fasnacht|invocavit|invocabit", -42),
    (r"reminisc", -35), (r"ocul[iy]", -28), (r"letare|laetare|mitt?ervast|mittvast|mitfast", -21),
    (r"judica|judika", -14), (r"palm", -7), (r"grun(?:en|donstag)|cena domini|hohen? donstag", -3),
    (r"karfritag|kar fritag|parasceve|stillen? fritag", -2),
    (r"ost(?:er|ren|r)|pas[c]h?[ae]|resurrection", 0),
    (r"quasi ?modo|wissen sunnentag", 7), (r"misericordia", 14), (r"jubilate", 21), (r"cantate", 28),
    (r"rogate|kruzwuch|crutzwuch|rogation", 35), (r"auffart|uffart|ufart|ascension|himelfart (?:christi|unsers herren)", 39),
    (r"exaudi", 42), (r"pfingst|pfingsten|pfinxt|penth?ecost", 49), (r"trinitat|drifaltig", 56),
    (r"fronlich|fronlichnam|corporis christi|corpus christi|unsers herren fronlich", 60),
]
WEEKDAYS = [  # pattern -> weekday (0 = Monday)
    (r"\b(?:sunnen ?tag|sunntag|suntag|sonntag|sontag|dominica|dominic)\b", 6),
    (r"\b(?:men ?tag|mentag|montag|mendag|feria (?:ii|secunda)|die lune|lune)\b", 0),
    (r"\b(?:zin\w*tag|zinstag|cinstag|dinstag|dienstag|zistag|feria (?:iii|tercia|tertia)|die martis|martis)\b", 1),
    (r"\b(?:mit\w*woch\w*|mitwuch\w*|mittwuchen|mittwoch|feria (?:iiii|iv|quarta)|die mercurii|mercurii)\b", 2),
    (r"\b(?:don\w*stag|donstag|donrstag|dunstag|feria (?:v|quinta)|die jovis|jovis)\b", 3),
    (r"\b(?:fr[iy]t\w*|fr[iy]tag|feria (?:vi|sexta)|die veneris|veneris)\b", 4),
    (r"\b(?:sam\w*stag|samstag|sampstag|sabbato|sabato|sabbati|sabbatho|sabb?to)\b", 5),
    (r"\b(?:secunda|ii)\b(?= (?:post|ante|proxim))", 0), (r"\b(?:tercia|tertia|iii)\b(?= (?:post|ante|proxim))", 1),
    (r"\b(?:quarta|iiii|iv)\b(?= (?:post|ante|proxim))", 2), (r"\b(?:quinta|v)\b(?= (?:post|ante|proxim))", 3),
    (r"\b(?:sexta|vi)\b(?= (?:post|ante|proxim))", 4),
]
MONTHS = [(r"ian|jan", 1), (r"feb|hornung", 2), (r"mar[tc]|mertz|merz", 3), (r"apr|app?l|abrel|aprel", 4),
          (r"mai|may|meyen|meien", 5), (r"[ij]un|brachot|brachmon", 6), (r"[ij]ul|howmon|heumon", 7),
          (r"aug|ougst|aogst", 8), (r"sept|herbstmon", 9), (r"oct|okt|winmon", 10),
          (r"nov|wintermon", 11), (r"dec|dez|christmon|wolfmon", 12)]
ORDINAL = {"prima": 1, "primo": 1, "secunda": 2, "secundo": 2, "tercia": 3, "tertia": 3, "tercio": 3, "quarta": 4,
           "quarto": 4, "quinta": 5, "quinto": 5, "sexta": 6, "sexto": 6, "septima": 7, "septimo": 7, "octava": 8,
           "octavo": 8, "nona": 9, "nono": 9, "decima": 10, "decimo": 10, "undecima": 11, "duodecima": 12, "duodena": 12,
           "vicesima": 20, "vigesima": 20, "tricesima": 30, "ultima": 0, "penultima": -1}


def roman(tok: str) -> int | None:
    """Roman numeral as scribes wrote them: j for i, a trailing 'mo/o/to' or '°'."""
    t = re.sub(r"(mo|to|ta|o|us|um|a)$", "", tok.lower().replace("j", "i").replace(".", ""))
    if not t or not re.fullmatch(r"[mdclxvi]+", t):
        return None
    val = {"m": 1000, "d": 500, "c": 100, "l": 50, "x": 10, "v": 5, "i": 1}
    total = 0
    for i, ch in enumerate(t):
        v = val[ch]
        total += -v if i + 1 < len(t) and val[t[i + 1]] > v else v
    return total


def number(tok: str) -> int | None:
    tok = tok.strip(".")
    if tok.isdigit():
        return int(tok)
    m = re.fullmatch(r"(\d+)(?:ten|ste|sten|ter|t|a|o|°)?", tok)
    if m:
        return int(m.group(1))
    return roman(tok)


GERMAN = {"ein": 1, "eins": 1, "einem": 1, "zwei": 2, "zwey": 2, "zwo": 2, "dri": 3, "drü": 3, "dru": 3, "drie": 3,
          "druzehen": 13, "vierzehen": 14, "vierzechen": 14, "funfzehen": 15, "einlif": 11, "einlift": 11,
          "vier": 4, "fier": 4, "funf": 5, "funff": 5, "fünf": 5, "sechs": 6, "sachs": 6, "siben": 7, "sibe": 7,
          "sibne": 7, "acht": 8, "achte": 8, "nun": 9, "nune": 9, "zehen": 10, "zechen": 10, "einlif": 11, "elf": 11,
          "zwolf": 12, "zwelf": 12, "zwentzig": 20, "zwenzig": 20, "drissig": 30, "drisig": 30, "viertzig": 40,
          "fiertzig": 40, "funfzig": 50, "funftzig": 50, "sechzig": 60, "sechtzig": 60, "sibenzig": 70,
          "sibentzig": 70, "achtzig": 80, "nunzig": 90, "nuntzig": 90, "drissigo": 30, "drissig": 30}
LATIN_UNITS = {"primo": 1, "secundo": 2, "tercio": 3, "tertio": 3, "quarto": 4, "quinto": 5, "sexto": 6,
               "septimo": 7, "octavo": 8, "nono": 9, "decimo": 10, "vicesimo": 20, "vigesimo": 20,
               "tricesimo": 30, "tricefimo": 30, "quadragesimo": 40, "quinquagesimo": 50, "sexagesimo": 60,
               "septuagesimo": 70, "octogesimo": 80, "nonagesimo": 90}
DOMINI = r"\b(?:domini|dominj|dni|dnj|dno|dmi|dmj|dm|dn|dom|d|etc|ec|et cetera|cetera|incarnationis|nativitatis|" \
         r"natiuitatis|a nativitate|christi|xpi|cristi|gebur\w*|gepur\w*|zalt|von|vo|vom|uo|man|da|do|als|des|jars?|" \
         r"jare|iar|iares|incipiente|in dem|dem|jar|von der)\b"


def german_year(t: str) -> int | None:
    """"tusent funff hundert zwentzig unnd sechs", "fier hundert un sibe" (thousand implied)."""
    t = re.sub(r"hund\s*t\b|hundt\b", "hundert", t)
    if not re.search(r"hundert|tusent|tuseng|tusend", t):
        return None
    t = re.sub(r"(hundert|tusent|tuseng|tusend)", r" \1 ", t)  # "druezehenhundert" -> "druezehen hundert"
    total, cur = 0, 0
    for w in re.findall(r"[a-z]+", t):
        if w.startswith("drue"):
            w = "dru" + w[4:]
        if w not in GERMAN and not w.endswith(("zehen", "zechen")):  # ordinals: "einliften", "drissigosten"
            stem = re.sub(r"(?<=.{3})(osten|esten|isten|sten|ten|ste|en)$", "", w)
            w = stem if stem in GERMAN else w
        w2 = re.sub(r"(zehen|zechen)$", "", w) if w.endswith(("zehen", "zechen")) and w not in ("zehen", "zechen") else None
        if w in GERMAN:
            cur += GERMAN[w]
        elif w2 is not None and w2 in GERMAN:
            cur += GERMAN[w2] + 10
        elif w.startswith(("tusent", "tuseng", "tusend")):
            total += (cur or 1) * 1000; cur = 0
        elif w.startswith("hundert"):
            total += (cur or 1) * 100; cur = 0
    total += cur
    if 100 <= total < 1000:
        total += 1000
    return total if 1200 <= total <= 1799 else None


def read_year(t: str) -> tuple[int | None, bool]:
    """(year or abbreviated year, written in full?)."""
    m = re.search(r"\b(1[2-7]\d\d)\b", t)
    if m:
        return int(m.group(1)), True
    # Arabic figures written apart with points: "1. 5. 72", "1.5.72" (BAT 666.1, Nr. 439);
    # norm() has turned the points into spaces by now
    m = re.search(r"\b(1)\s+([2-7])\s+(\d\d)\b\s*$", t)
    if m:
        return int(m.group(1) + m.group(2) + m.group(3)), True
    g = german_year(t)
    if g:
        return g, True
    m = re.search(r"\b(?:anno|ano|ao|a|im|jars?|jahr|iar)\b(.*)$", t)
    if m and m.group(1).strip():
        tail = m.group(1)
    else:  # no "anno": the year is the numeral group after the month or feast, i.e. the last one
        groups = re.findall(r"(?:\b[mdclxvij]+(?:mo|to|o|no|do)?\b\s*)+", t)
        tail = groups[-1] if groups else t
    tail = re.sub(DOMINI, " ", tail)
    # joined forms: "lxxquinto", "lprimo", "xxxixno", "xvciiij"
    tail = re.sub(r"\b([mdclxvij]+?|(?:vi|tri|quadra|quinqua|sexa|septua|octo|nona)[cg]esimo)"
                  r"(primo|secundo|tercio|tertio|quarto|quinto|sexto|septimo|octavo|nono)\b", r"\1 \2", tail)
    tail = re.sub(r"\b([mdclxvij]+?)(no|mo|to|do|o)\b", r"\1", tail)
    h = re.search(r"\b([xvij]+)\s*c\s*([mdclxvij]*)\b", tail)
    if h and roman(h.group(1)):
        v = roman(h.group(1)) * 100 + (roman(h.group(2)) or 0 if h.group(2) else 0)
        return (v + 1000 if v < 1000 else v), True
    total = 0
    for tok in tail.split():
        if total and tok in ("mo", "o", "to", "no", "do"):  # "xiiii mo": the ending, written apart
            continue
        if tok in LATIN_UNITS:
            total += LATIN_UNITS[tok]
            continue
        v = int(tok) if tok.isdigit() and len(tok) <= 2 else roman(tok)
        if v is None:
            if total:
                break
            continue
        total += v
    if not total:
        return None, False
    if 100 <= total < 800 and re.search(r"\bc", tail):  # the thousand left out: "cccclxxxxv"
        return total + 1000, True
    if total > 1799:
        return None, False
    return total, total >= 1000


FEAST_NAMES = {(1, 1): "Neujahr", (1, 6): "Dreikönige", (1, 13): "St. Hilarius", (1, 14): "St. Felix",
    (1, 17): "St. Antonius", (1, 20): "St. Sebastian", (1, 21): "St. Agnes", (1, 22): "St. Vinzenz",
    (1, 25): "Pauli Bekehrung", (2, 2): "Lichtmess", (2, 3): "St. Blasius", (2, 5): "St. Agatha", (2, 6): "St. Dorothea",
    (2, 14): "St. Valentin", (2, 22): "Petri Stuhlfeier", (2, 24): "St. Matthias", (3, 12): "St. Gregor",
    (3, 17): "St. Gertrud", (3, 21): "St. Benedikt", (3, 25): "Mariä Verkündigung", (4, 4): "St. Ambrosius",
    (4, 23): "St. Georg", (4, 25): "St. Markus", (5, 1): "Philipp und Jakob", (5, 3): "Kreuzauffindung",
    (5, 12): "St. Pankraz", (5, 25): "St. Urban", (6, 5): "St. Bonifatius", (6, 15): "St. Vitus",
    (6, 22): "Zehntausend Ritter", (6, 24): "Johannes der Täufer", (6, 29): "Peter und Paul",
    (7, 2): "Mariä Heimsuchung", (7, 4): "St. Ulrich", (7, 13): "St. Margaretha", (7, 22): "Maria Magdalena",
    (7, 25): "St. Jakob", (7, 26): "St. Anna", (8, 1): "Petri Kettenfeier", (8, 5): "St. Oswald", (8, 7): "St. Afra",
    (8, 10): "St. Laurentius", (8, 15): "Mariä Himmelfahrt", (8, 24): "St. Bartholomäus", (8, 28): "St. Augustin",
    (8, 29): "Johannes Enthauptung", (9, 1): "St. Verena", (9, 8): "Mariä Geburt", (9, 14): "Kreuzerhöhung",
    (9, 21): "St. Matthäus", (9, 22): "St. Mauritius", (9, 29): "St. Michael", (10, 2): "St. Leodegar",
    (10, 4): "St. Franziskus", (10, 16): "St. Gallus", (10, 18): "St. Lukas", (10, 21): "Elftausend Jungfrauen",
    (10, 28): "Simon und Juda", (11, 1): "Allerheiligen", (11, 2): "Allerseelen", (11, 11): "St. Martin",
    (11, 16): "St. Othmar", (11, 19): "St. Elisabeth", (11, 22): "St. Cäcilia", (11, 23): "St. Clemens",
    (11, 25): "St. Katharina", (11, 26): "St. Konrad", (11, 30): "St. Andreas", (12, 4): "St. Barbara",
    (12, 6): "St. Nikolaus", (12, 8): "Mariä Empfängnis", (12, 13): "St. Lucia", (12, 21): "St. Thomas",
    (12, 25): "Weihnachten", (12, 26): "St. Stephan", (12, 27): "Johannes Evangelist", (12, 28): "Unschuldige Kinder",
    (12, 31): "St. Silvester"}
MOVABLE_NAMES = {-63: "Septuagesima", -56: "Sexagesima", -49: "Estomihi (Herrenfasnacht)", -46: "Aschermittwoch",
    -42: "Invocavit (alte Fasnacht)", -35: "Reminiscere", -28: "Oculi", -21: "Laetare (Mittfasten)", -14: "Judica",
    -7: "Palmsonntag", -3: "Gründonnerstag", -2: "Karfreitag", 0: "Ostern", 7: "Quasimodogeniti",
    14: "Misericordia Domini", 21: "Jubilate", 28: "Cantate", 35: "Rogate", 39: "Auffahrt", 42: "Exaudi",
    49: "Pfingsten", 56: "Trinitatis", 60: "Fronleichnam"}
LAST_FEAST: list[str] = [""]


def read_day(t: str, year: int | None) -> tuple[tuple[int, int, int] | None, str]:
    """((y, m, d) Julian, how) or (None, why not)."""
    if year is None:
        return None, "no year"
    # 1. in figures
    t = t.replace("j", "i")
    for mo_pat, mo in MONTHS:
        m = re.search(rf"\b(\w+)\s+(?:die|tag|tage)?\s*(?:des\s+|me\w*\s+)?(?:{mo_pat})\w*", t)
        if m:
            tok = m.group(1)
            d = ORDINAL.get(tok)
            if d is None:
                d = number(tok)
            if d in (0, -1):  # ultima, penultima
                nxt = jdn(year + (mo == 12), mo % 12 + 1, 1)
                return from_jdn(nxt - 1 + d), "figures (ultima)" if d == 0 else "figures (penultima)"
            if d and 1 <= d <= 31:
                return (year, mo, d), "figures"
    # 2. a feast: fixed or movable, with eve or weekday
    t = feastform(t)
    t = re.sub(r"\b\w*(?:gesimo|cesimo|centesimo|millesimo)\w*\b", " ", t)  # year words ("septuagesimo")
    feast_j, feast_name = None, ""
    for pat, (mo, d) in FIXED:
        m = re.search(pform(pat), t)
        if m:
            feast_j, feast_name = jdn(year, mo, d), m.group(0)
            LAST_FEAST[0] = FEAST_NAMES.get((mo, d), "")
            break
    if feast_j is None:
        for pat, off in MOVABLE:
            m = re.search(pform(pat), t)
            if m:
                feast_j, feast_name = easter(year) + off, m.group(0)
                LAST_FEAST[0] = MOVABLE_NAMES.get(off, "")
                break
    if feast_j is None:
        return None, "no day"
    fpos = t.find(feast_name)
    before = t[:fpos]
    wd = None
    for pat, w in WEEKDAYS:
        if re.search(pform(pat), before):
            wd = w
    after = t[fpos + len(feast_name):fpos + len(feast_name) + 14]
    if wd is None:
        for pat, w in WEEKDAYS[:7]:
            if re.match(r"\W*(?:tag\s+)?" + pform(pat).replace("\\b(?:", "(?:", 1), after):
                wd = w
    if not re.search(r"\b(?:nach|post)\b", before) and \
            re.search(r"\b(?:abent|abend|aubent|uigili\w*|uorabend)\b", before + t[fpos:fpos + len(feast_name) + 12]):
        return from_jdn(feast_j - 1), "eve of a feast"
    if wd is None:
        if re.search(r"\b(?:crastin\w*|morndes|morn)\b", before):
            return from_jdn(feast_j + 1), "day after a feast"
        if re.search(r"\b(?:octau)", before):
            return from_jdn(feast_j + 7), "octave of a feast"
        if re.search(r"\b(?:nach|post|uor|ante|an)\b", before):
            return None, "weekday not read"
        return from_jdn(feast_j), "feast day"
    if re.search(r"\b(?:uor|uorr|ante|an)\b", before):
        k = feast_j - 1
        while weekday(k) != wd:
            k -= 1
        return from_jdn(k), "weekday before a feast"
    # "nach", "post", "nechst nach", or the weekday alone (in the week of the feast)
    k = feast_j + 1
    while weekday(k) != wd:
        k += 1
    return from_jdn(k), "weekday after a feast"


FIXED_DAY = ("figures", "feast day", "eve of a feast", "day after a feast", "figures (ultima)", "figures (penultima)")


def letters() -> list[dict]:
    with (ROOT / "readings" / "letters.tsv").open(encoding="utf-8") as fh:
        return list(csv.DictReader(fh, delimiter="\t"))


def main() -> None:
    drafts = {}
    for line in (ROOT / "regests" / "drafts.jsonl").read_text(encoding="utf-8").splitlines():
        if line.strip():
            r = json.loads(line)
            if "error" not in r["draft"]:
                drafts[r["id"]] = r
    rows = []
    for lt in letters():
        d = drafts.get(lt["id"], {}).get("draft") or {}
        text = d.get("date_text") or ""
        y, full = read_year(norm(text)) if text else (None, False)
        rows.append({"id": lt["id"], "shelf": lt["shelf"], "nr": lt["nr"], "date_text": text,
                     "y_raw": y, "full": full})
    # century for abbreviated years: the full years nearby in the same volume (shelf)
    by_shelf: dict[str, list[tuple[int, int]]] = {}
    for i, r in enumerate(rows):
        if r["full"] and r["y_raw"] and 1200 <= r["y_raw"] <= 1799:
            by_shelf.setdefault(r["shelf"], []).append((i, r["y_raw"]))
    out = []
    for i, r in enumerate(rows):
        rec = {"id": r["id"], "date_text": r["date_text"] or None}
        y = r["y_raw"]
        if y is not None and r["full"] and 1200 <= y <= 1799:
            rec["year"], rec["century"] = y, "written"
        elif y is not None and y < 100:
            near = sorted(by_shelf.get(r["shelf"], []), key=lambda p: abs(p[0] - i))[:8]
            cent = statistics.median_low([v // 100 * 100 for _, v in near]) if near else 1400
            cand = cent + y
            # nearest century to the neighbours' years
            if near:
                ref = statistics.median([v for _, v in near])
                cand = min((c + y for c in (cent - 100, cent, cent + 100)), key=lambda v: abs(v - ref))
            rec["year"], rec["century"] = cand, "neighbours" if near else "default"
        if "year" in rec and rec["century"] != "written":
            # a weekday named beside a day fixed otherwise decides the century
            ff = feastform(norm(r["date_text"]))
            said = [w for pat, w in WEEKDAYS[:7] if re.search(pform(pat), ff)]
            if said:
                fits = []
                for c in (1300, 1400, 1500, 1600):
                    yy = c + rec["year"] % 100
                    d0, h0 = read_day(norm(r["date_text"]), yy)
                    if d0 and h0 in FIXED_DAY and weekday(jdn(*d0)) == said[-1]:
                        fits.append(yy)
                # the weekday only tests the year: with four centuries to choose from, a misread day
                # fits some weekday by chance in about one case in three, so it never sets the year
                if fits and rec["year"] not in fits:
                    rec["weekday_fits"] = fits
        if "year" in rec:
            LAST_FEAST[0] = ""
            day, how = read_day(norm(r["date_text"]), rec["year"])
            if day and how not in ("figures", "figures (ultima)", "figures (penultima)") and LAST_FEAST[0]:
                rec["feast"] = LAST_FEAST[0]
            if day:
                yy, mm, dd = day
                said = None
                ff = feastform(norm(r["date_text"]))
                for pat, w in WEEKDAYS[:7]:
                    if re.search(pform(pat), ff):
                        said = w
                if said is not None and how in FIXED_DAY:
                    rec["weekday_check"] = "ok" if said == weekday(jdn(yy, mm, dd)) else "mismatch"
                rec["date"] = f"{yy:04d}-{mm:02d}-{dd:02d}"
                rec["how"] = how
                rec["weekday"] = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"][weekday(jdn(yy, mm, dd))]
                rec["calendar"] = "julian"
                if mm == 12 and dd >= 25:
                    rec["year_start"] = "christmas?"
            else:
                rec["how"] = how
        out.append(rec)
    (ROOT / "dates").mkdir(exist_ok=True)
    with (ROOT / "dates" / "dates.jsonl").open("w", encoding="utf-8") as fh:
        for rec in out:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    from collections import Counter
    n = len(out)
    yr = sum(1 for r in out if "year" in r)
    dy = sum(1 for r in out if "date" in r)
    from collections import Counter
    wc = Counter(r.get("weekday_check") for r in out if r.get("weekday_check"))
    print(f"weekday named in the line and computed independently: {dict(wc)}")
    print(f"{n} letters; {sum(1 for r in out if r['date_text'])} with a date line; {yr} with a year "
          f"({Counter(r.get('century') for r in out if 'year' in r)}); {dy} with a day "
          f"({Counter(r.get('how') for r in out if 'date' in r)})")


if __name__ == "__main__":
    main()
