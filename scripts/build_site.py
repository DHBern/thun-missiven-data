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
  readings/readers.json         who each reader is (label, kind, about, caveat; en + _de)
  regests/drafts.jsonl          machine-drafted heading and regest per letter (latest wins)
  entities/<reader>.jsonl       automatic tagging of a reading (optional; none yet)

Outputs (site/data/)
  index.json                    letters (id, shelf, nr, pages, thumbnail, draft heading,
                                year, sender, recipient), search shard counts
  readers.json                  readers with pages read and pairwise disagreement
  letters/<n>.json              CHUNK letters in index order, each with its pages,
                                every reading, the image and the draft
  pagekeys.json                 page key -> [letter id, page position]: old page links
  search/<reader>/text-<n>.json letter id -> page texts, loaded only by a search

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


def main() -> None:
    pages = {p["key"]: p for p in tsv("pages.tsv")}
    images = {r["key"]: r for r in tsv("images.tsv")}
    rows = tsv("letters.tsv")
    readings = load_readings(set(pages))
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
            for r, ents in entities.items():
                if key in ents and r in rec["readings"]:
                    rec.setdefault("ents", {})[r] = ents[key]
            recs.append(rec)
        d = drafts.get(lt["id"])
        full = {"id": lt["id"], "shelf": lt["shelf"], "nr": lt["nr"], "title": lt["title"], "doc": lt["doc"], "pages": recs}
        if d:
            full["draft"] = d
        chunk.append(full)
        row = {"id": lt["id"], "shelf": lt["shelf"], "nr": lt["nr"], "n": lt["n_main"],
               "tk": recs[0]["tk"] if recs else ""}
        if len(recs) > lt["n_main"]:
            row["x"] = len(recs) - lt["n_main"]
        if d:
            row.update({"h": d["heading"], "y": d["year"], "s": d["sender"], "r": d["recipient"]})
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
    (OUT / "index.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (OUT / "pagekeys.json").write_text(json.dumps(pagekeys, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (OUT / "readers.json").write_text(json.dumps(readers, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"{len(pages)} pages in {len(letters)} letters, {len(drafts)} with a drafted regest")
    for r in readers:
        print(f"  {r['id']:<40} read {r['pages_read']:>5}")
    for (a, b), t in pair.items():
        if t["pages"]:
            print(f"  disagreement {a} | {b}: {t['edits'] / t['chars']:.4f} over {t['pages']} pages")


if __name__ == "__main__":
    main()
