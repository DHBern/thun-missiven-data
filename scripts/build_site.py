"""Build the viewer's data from the machine readings of the Thun Missives.

    python scripts/build_site.py            # writes site/data/

The unit is the **letter**: readings/letters.tsv splits the Transkribus
documents into letters by the scan file names (scripts/letters.py), and every
letter carries its pages with their readings, the page image on Transkribus
(IIIF), and the regest drafted by a language model, where there is one.

There is no edition and no ground truth for this corpus: every reading is a
machine's, and none is scored. Where a page has more than one reading, the
build measures how much two readings **disagree** — never how good either is.

Inputs
  readings/pages.tsv            every page of the corpus (key, doc, pageNr, lines, …)
  readings/letters.tsv          letters in signature order: id, shelf, nr, title, doc,
                                pages, sides, extra (a second scan series)
  readings/images.tsv           one row per page key: letter, side, note, img, tk
                                (the IIIF identifier on files.transkribus.eu), size
  readings/<reader>.jsonl       one line per page: {"key": <page key>, "text": ...}
  readings/lines.jsonl          the Transkribus TextLines of each page: outline and PyLaia
                                text (scripts/import_transkribus.py; docs/LINES.md)
  readings/readers.json         who each reader is (label, kind, about, caveat; en + _de)
  regests/drafts.jsonl          machine-drafted heading and regest per letter (latest wins)
  dates/dates.jsonl             year and day of each letter, read by rule from the date line
                                (scripts/dates.py; days in the Julian calendar)
  keywords/vocabulary.json      the keyword vocabulary (the St. Gallen edition's terms, flat)
  keywords/assigned.jsonl       machine-assigned terms per letter (scripts/keywords.py;
                                latest line wins); optional: without it no keywords are shown
  entities/<reader>.jsonl       automatic tagging of a reading (optional)
  registers/{places,persons,orgs}.json
                                the register generated from the tagging (scripts/register.py;
                                optional: without it the viewer shows no register, map or facets)

Outputs (site/data/)
  index.json                    letters (id, shelf, nr, pages, thumbnail, draft heading,
                                sender, recipient; year ``y`` and day ``d`` from dates.jsonl,
                                ``yu`` when the century is not written; keyword terms ``k``),
                                search shard counts, and ``vocabulary`` (version, number of
                                terms) when keywords exist
  readers.json                  readers with pages read and pairwise disagreement
  letters/<n>.json              CHUNK letters in index order, each with its pages,
                                every reading, the image and the draft; a page with
                                lines carries ``rows`` (each line's outline) and every
                                reading ``ln`` (per text line the rows it is linked to)
  pagekeys.json                 page key -> [letter id, page position]: old page links
  search/<reader>/text-<n>.json letter id -> page texts, loaded only by a search
  registers.json                entries of the generated register (kind, name, spellings,
                                letters, years, coordinates, graded candidates), loaded by the
                                overview map, the register pages and the search; each tagged
                                name in letters/<n>.json carries ``reg``, its entry

Disagreement between two readings of a page = Levenshtein edits ÷ the length of
the longer reading, whitespace collapsed. It is symmetric, 0 when they agree,
and says nothing about which of the two is right: a model that invents fluent
text disagrees exactly as much as one that reads badly.
"""

from __future__ import annotations

import csv
import itertools
import json
import shutil
import sys
from pathlib import Path

from rapidfuzz.distance import Levenshtein

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import line_links  # noqa: E402

NOT_READERS = {"lines"}         # readings/*.jsonl that hold no reading
OUT = ROOT / "site" / "data"
CHUNK = 25                      # letters per file the viewer loads at once
SEARCH_SHARD_CHARS = 1_500_000  # text per search shard, loaded in parallel


def flat(text: str) -> str:
    return " ".join(text.split())


def clean_reading(text: str) -> str:
    """Drop the empty lines a line-based engine leaves for every segment it
    could not read; keep every other line."""
    return "\n".join(line.rstrip() for line in (text or "").splitlines() if line.strip())


def tsv(name: str) -> list[dict]:
    with (ROOT / "readings" / name).open(encoding="utf-8") as fh:
        return list(csv.DictReader(fh, delimiter="\t"))


def load_readings(known: set[str]) -> dict[str, dict[str, dict]]:
    readings: dict[str, dict[str, dict]] = {}
    for path in sorted((ROOT / "readings").glob("*.jsonl")):
        if path.stem in NOT_READERS:
            continue
        pages, unknown = {}, []
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            rec = json.loads(line)
            if rec["key"] not in known:
                unknown.append(rec["key"])
                continue
            entry = {"text": clean_reading(rec.get("text", ""))}
            if rec.get("truncated"):
                entry["truncated"] = True
            pages[rec["key"]] = entry
        if unknown:
            print(f"  {path.name}: {len(unknown)} keys not in pages.tsv, e.g. {unknown[:3]}", file=sys.stderr)
        readings[path.stem] = pages
    return readings


def load_lines(known: set[str]) -> dict[str, dict]:
    """readings/lines.jsonl: per page key its rows (the TextLines, docs/LINES.md)."""
    path = ROOT / "readings" / "lines.jsonl"
    out: dict[str, dict] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rec = json.loads(line)
            if rec["key"] in known and rec.get("poly"):
                out[rec["key"]] = rec
    return out


def link_lines(rec: dict, geo: dict) -> dict[str, tuple[int, int]]:
    """Rows on the image for this page, and for every reading which rows each
    of its lines is on: ``rec["rows"]`` holds each TextLine's outline (x, y, x,
    y, ... in ten-thousandths of the image width), ``ln`` beside a reading per
    line the rows it is linked to, [] where no link was good enough. Returns
    per reader (lines linked, lines)."""
    rec["rows"] = geo["poly"]
    row_texts = [[t] for t in geo["text"]]
    counts = {}
    for reader, entry in rec["readings"].items():
        if not entry.get("text"):
            continue
        ln = line_links.align(entry["text"].split("\n"), row_texts)
        entry["ln"] = ln
        counts[reader] = (sum(1 for x in ln if x), len(ln))
    return counts


def load_entities() -> dict[str, dict[str, list]]:
    """entities/<reader>.jsonl, same format as the St. Gallen viewer's:
    {"key": ..., "entities": [{"start", "end", "type", "text", "ref"?, ...}]}."""
    out: dict[str, dict[str, list]] = {}
    folder = ROOT / "entities"
    for path in sorted(folder.glob("*.jsonl")) if folder.exists() else []:
        pages = {}
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                rec = json.loads(line)
                pages[rec["key"]] = rec["entities"]
        out[path.stem] = pages
    return out


REGISTER_FILES = ("places", "orgs", "persons")
CAND_KEEP = ("label", "grade", "rule", "srcs", "hls", "ssrq", "sg", "km", "birth", "death", "first", "last", "desc",
             "region", "type", "via", "links")


def load_registers(letter_ids: set[str]) -> tuple[dict | None, dict[tuple[str, int], str]]:
    """registers/{places,orgs,persons}.json (scripts/register.py) -> the viewer's
    registers.json, and (page key, start) -> entry id for the tagged names.
    Missing files are skipped: the site builds without a register."""
    entries, meta, occ = {}, {}, {}
    for name in REGISTER_FILES:
        path = ROOT / "registers" / f"{name}.json"
        if not path.exists():
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        meta.setdefault("measured", data.get("measured"))
        meta.setdefault("date", data.get("date"))
        meta[name] = {k: data.get(k) for k in ("counts", "by_source", "dropped", "with_coordinates") if data.get(k)}
        for eid, e in data["entries"].items():
            x = {"k": e["kind"], "n": e["name"], "f": e["forms"][:10], "m": e["mentions"],
                 "l": [lid for lid in e["letters"] if lid in letter_ids], "c": [{k: c[k] for k in CAND_KEEP if k in c} for c in e["candidates"]]}
            if e.get("years"):
                x["y"] = e["years"]
            if e.get("roles"):
                x["r"] = e["roles"]
            if e.get("geo"):
                x["g"], x["gg"], x["gf"] = e["geo"], e.get("geo_grade"), e.get("geo_from")
            if e.get("normalised"):
                x["nz"] = 1
            if e.get("offices"):  # registers/offices.json: the office the letters name this man in
                x["o"] = [{"t": o["office"], "y": o.get("years"), "n": len(o.get("letters", [])), "l": o.get("letters", [])[:40]}
                          for o in e["offices"]]
            entries[eid] = x
            for page, start, _end in e.get("occ", []):
                occ[(page, start)] = eid
    if not entries:
        return None, {}
    meta["entries"] = entries
    return meta, occ


def load_drafts(letter_ids: set[str]) -> dict[str, dict]:
    """regests/drafts.jsonl: the latest line per letter wins; a failed draft
    ({"error": ...}) shows nothing."""
    path = ROOT / "regests" / "drafts.jsonl"
    out: dict[str, dict] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        rec = json.loads(line)
        d = rec.get("draft") or {}
        if rec.get("id") not in letter_ids:
            print(f"  drafts.jsonl: unknown letter {rec.get('id')}", file=sys.stderr)
            continue
        if "error" in d or not (d.get("regest") or "").strip():
            out.pop(rec["id"], None)
            continue
        year = d.get("year")
        out[rec["id"]] = {
            "heading": rec.get("heading") or "",
            "reader": rec.get("reader") or "",
            "model": rec.get("model") or "",
            "sender": d.get("sender") or "",
            "recipient": d.get("recipient") or "",
            "place": d.get("place") or "",
            "date_text": d.get("date_text") or "",
            "year": year if isinstance(year, int) else None,
            "regest": d["regest"].strip(),
        }
    return out


def load_dates(letter_ids: set[str]) -> dict[str, dict]:
    """dates/dates.jsonl (scripts/dates.py): letter id -> its date record, without the id."""
    path = ROOT / "dates" / "dates.jsonl"
    out: dict[str, dict] = {}
    if not path.exists():
        print("  dates/dates.jsonl missing — run scripts/dates.py; no dates shown", file=sys.stderr)
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        rec = json.loads(line)
        lid = rec.pop("id", None)
        if lid not in letter_ids:
            print(f"  dates.jsonl: unknown letter {lid}", file=sys.stderr)
            continue
        if rec.get("date_text") or rec.get("year"):
            out[lid] = rec
    return out


def load_keywords(letter_ids: set[str]) -> tuple[dict | None, dict[str, list[str]]]:
    """keywords/vocabulary.json (the St. Gallen edition's flat list of terms; the
    term string is the key) and keywords/assigned.jsonl (terms per letter, the
    latest line per letter wins; an error line, or no keywords, shows nothing).
    Without assignments the viewer shows no keywords at all: returns (None, {})."""
    vpath, apath = ROOT / "keywords" / "vocabulary.json", ROOT / "keywords" / "assigned.jsonl"
    if not vpath.exists() or not apath.exists():
        return None, {}
    vocab = json.loads(vpath.read_text(encoding="utf-8"))
    terms = [t["term"] for t in vocab.get("terms", [])]
    known = set(terms)
    out: dict[str, list[str]] = {}
    unknown: set[str] = set()
    for line in apath.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        rec = json.loads(line)
        lid = rec.get("id")
        if lid not in letter_ids:
            print(f"  assigned.jsonl: unknown letter {lid}", file=sys.stderr)
            continue
        kws = [] if rec.get("error") else [k for k in rec.get("keywords") or [] if k in known]
        unknown.update(k for k in rec.get("keywords") or [] if k not in known)
        if kws:
            out[lid] = list(dict.fromkeys(kws))
        else:
            out.pop(lid, None)
    if unknown:
        print(f"  assigned.jsonl: {len(unknown)} terms not in the vocabulary, dropped, e.g. {sorted(unknown)[:5]}", file=sys.stderr)
    if not out:
        return None, {}
    return {"version": vocab.get("version"), "terms": len(terms)}, out


def write_search(letters: list[dict], readings: dict[str, dict[str, dict]], readers: list[str]) -> dict[str, int]:
    """Per reader: letter id -> the text of each of its pages ("" if unread),
    in the letter's page order (pages, then the further scans)."""
    out = OUT / "search"
    shards_of: dict[str, int] = {}
    for reader in readers:
        folder = out / reader
        folder.mkdir(parents=True, exist_ok=True)
        shards, cur, size = [], {}, 0
        for lt in letters:
            texts = [readings[reader].get(k, {}).get("text", "") for k in lt["keys"]]
            if not any(texts):
                continue
            while texts and not texts[-1]:
                texts.pop()
            cur[lt["id"]] = texts
            size += sum(len(t) for t in texts)
            if size >= SEARCH_SHARD_CHARS:
                shards.append(cur); cur, size = {}, 0
        if cur:
            shards.append(cur)
        for i, shard in enumerate(shards):
            (folder / f"text-{i}.json").write_text(json.dumps(shard, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        shards_of[reader] = len(shards)
    return shards_of


def load_cross_links() -> dict[str, list[dict]]:
    """Hints to letters in other collections (links/<collection>.json): letter id ->
    [{collection, kind, de, en, url, label}]. Each says what the relation is, never more."""
    out: dict[str, list[dict]] = {}
    for path in sorted((ROOT / "links").glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        for ln in data["links"]:
            other = ln.get("other")
            out.setdefault(ln["letter"], []).append({
                "collection": path.stem, "kind": ln["kind"], "de": ln["de"], "en": ln["en"],
                "url": f"{data['viewer']}#/letter/{other}/1" if other else data["viewer"],
                "label": ln.get("label") or other or ""})
    return out


def main() -> None:
    pages = {p["key"]: p for p in tsv("pages.tsv")}
    images = {r["key"]: r for r in tsv("images.tsv")}
    rows = tsv("letters.tsv")
    readings = load_readings(set(pages))
    lines = load_lines(set(pages))
    entities = load_entities()
    listed = json.loads((ROOT / "readings" / "readers.json").read_text(encoding="utf-8"))
    for r in listed:
        if r["id"] not in readings:
            print(f"  reader {r['id']}: no readings/{r['id']}.jsonl yet — not shown", file=sys.stderr)
    for rid in readings:
        if rid not in {r["id"] for r in listed}:
            print(f"  readings/{rid}.jsonl: not in readers.json — not shown", file=sys.stderr)
    readers = [r for r in listed if readings.get(r["id"])]
    ids = [r["id"] for r in readers]
    drafts = load_drafts({r["id"] for r in rows})
    dates = load_dates({r["id"] for r in rows})
    vocab, keywords = load_keywords({r["id"] for r in rows})
    registers, reg_occ = load_registers({r["id"] for r in rows})

    # every page key of letters.tsv must be a page, and no page may be lost
    letters, seen = [], set()
    for r in rows:
        main_keys = [k for k in r["pages"].split(";") if k]
        extra = [k for k in (r.get("extra") or "").split(";") if k]
        missing = [k for k in main_keys + extra if k not in pages]
        if missing:
            sys.exit(f"letters.tsv: {r['id']} names pages not in pages.tsv: {missing[:3]}")
        seen.update(main_keys + extra)
        letters.append({**r, "keys": main_keys + extra, "n_main": len(main_keys)})
    lost = [k for k in pages if k not in seen]
    if lost:
        print(f"  {len(lost)} pages in no letter, e.g. {lost[:3]}", file=sys.stderr)

    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "letters").mkdir(parents=True)

    pair = {(a, b): {"edits": 0, "chars": 0, "pages": 0} for a, b in itertools.combinations(ids, 2)}
    read = {r: 0 for r in ids}
    linked = {r: [0, 0] for r in ids}   # lines linked, lines on pages with rows
    cross_links = load_cross_links()
    index, pagekeys, chunk = [], {}, []
    for pos, lt in enumerate(letters):
        recs = []
        for i, key in enumerate(lt["keys"]):
            p, img = pages[key], images.get(key, {})
            pagekeys[key] = [lt["id"], i + 1]
            rec = {"key": key, "side": img.get("side", ""), "tk": img.get("tk", ""),
                   "w": int(img["width"]) if str(img.get("width", "")).isdigit() else None,
                   "h": int(img["height"]) if str(img.get("height", "")).isdigit() else None,
                   "img": img.get("img", ""),
                   "lines": int(p["lines"]) if str(p.get("lines", "")).isdigit() else None,
                   "lm": p.get("pylaia_lm") or "", "readings": {}}
            if img.get("note"):
                rec["note"] = img["note"]
            if i >= lt["n_main"]:
                rec["extra"] = True
            for r in ids:
                rd = readings[r].get(key)
                if rd is not None:
                    rec["readings"][r] = rd
                    read[r] += 1
            dis = {}
            for a, b in itertools.combinations([r for r in ids if rec["readings"].get(r, {}).get("text")], 2):
                ta, tb = flat(rec["readings"][a]["text"]), flat(rec["readings"][b]["text"])
                edits = Levenshtein.distance(ta, tb)
                longer = max(len(ta), len(tb))
                dis[f"{a}|{b}"] = round(edits / longer, 4)
                t = pair[(a, b)]
                t["edits"] += edits; t["chars"] += longer; t["pages"] += 1
            if dis:
                rec["dis"] = dis
            if key in lines:
                for r, (a, b) in link_lines(rec, lines[key]).items():
                    linked[r][0] += a
                    linked[r][1] += b
            for r, ents in entities.items():
                if key in ents and r in rec["readings"]:
                    if r == "gemini-4-argon" and reg_occ:  # the register is built from this tagging
                        ents[key] = [{**e, "reg": reg_occ[(key, e["start"])]} if (key, e["start"]) in reg_occ else e
                                     for e in ents[key]]
                    rec.setdefault("ents", {})[r] = ents[key]
            recs.append(rec)
        d = drafts.get(lt["id"])
        full = {"id": lt["id"], "shelf": lt["shelf"], "nr": lt["nr"], "title": lt["title"], "doc": lt["doc"], "pages": recs}
        if d:
            full["draft"] = d
        dt = dates.get(lt["id"])
        if dt:
            full["date"] = dt
        if lt["id"] in keywords:
            full["keywords"] = keywords[lt["id"]]
        if lt["id"] in cross_links:
            full["links"] = cross_links[lt["id"]]
        chunk.append(full)
        row = {"id": lt["id"], "shelf": lt["shelf"], "nr": lt["nr"], "n": lt["n_main"],
               "tk": recs[0]["tk"] if recs else ""}
        if len(recs) > lt["n_main"]:
            row["x"] = len(recs) - lt["n_main"]
        if d:
            row.update({"h": d["heading"], "s": d["sender"], "r": d["recipient"]})
        if dt and dt.get("year"):
            row["y"] = dt["year"]
            if dt.get("century") != "written":
                row["yu"] = 1
            if dt.get("date"):
                row["d"] = dt["date"]
        if lt["id"] in keywords:
            row["k"] = keywords[lt["id"]]
        index.append(row)
        if len(chunk) == CHUNK or pos == len(letters) - 1:
            (OUT / "letters" / f"{pos // CHUNK}.json").write_text(json.dumps(chunk, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            chunk = []

    for r in readers:
        r["pages_read"] = read[r["id"]]
        r["entities"] = r["id"] in entities
        r["disagreement"] = {}
    by_id = {r["id"]: r for r in readers}
    for (a, b), t in pair.items():
        if t["pages"]:
            x = {"value": round(t["edits"] / t["chars"], 4), "pages": t["pages"]}
            by_id[a]["disagreement"][b] = x
            by_id[b]["disagreement"][a] = x

    shards = write_search(letters, readings, ids)
    out = {"chunk": CHUNK, "pages": len(pages), "letters": index, "search": shards}
    if vocab:
        out["vocabulary"] = vocab
    if registers:
        (OUT / "registers.json").write_text(json.dumps(registers, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        out["registers"] = {k: sum(1 for e in registers["entries"].values() if e["k"] == k) for k in ("place", "person", "org")}
    (OUT / "index.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (OUT / "pagekeys.json").write_text(json.dumps(pagekeys, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (OUT / "readers.json").write_text(json.dumps(readers, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"{len(pages)} pages in {len(letters)} letters, {len(drafts)} with a drafted regest; "
          f"{sum(1 for k in lines if k in seen)} with line outlines; "
          f"{sum(1 for r in index if r.get('y'))} with a year, {sum(1 for r in index if r.get('d'))} with a day; "
          f"{len(keywords)} with keywords; register: {out.get('registers') or 'none'}")
    for r in readers:
        a, b = linked[r["id"]]
        print(f"  {r['id']:<40} read {r['pages_read']:>5}; lines linked to the image {a} of {b}"
              f"{f' ({a / b:.1%})' if b else ''}")
    for (a, b), t in pair.items():
        if t["pages"]:
            print(f"  disagreement {a} | {b}: {t['edits'] / t['chars']:.4f} over {t['pages']} pages")


if __name__ == "__main__":
    main()
