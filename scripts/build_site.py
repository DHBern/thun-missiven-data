"""Build the viewer's data from the machine readings of the Thun Missiven.

    python scripts/build_site.py            # writes site/data/

There is no edition and no ground truth for this corpus: every reading is a
machine's, and none is scored. Where a page has more than one reading, the
build measures how much two readings **disagree** — never how good either is.

Inputs
  readings/pages.tsv            every page of the corpus, in shelfmark order
  readings/<reader>.jsonl       one line per page: {"key": <page key>, "text": ...}
  readings/readers.json         who each reader is (label, kind, about, caveat; en + _de)
  entities/<reader>.jsonl       automatic tagging of a reading (optional; none yet)

Outputs (site/data/)
  index.json                    documents with their pages; search shard counts
  readers.json                  readers with pages read and pairwise disagreement
  pages/<doc>/<n>.json          CHUNK pages of one document with every reading
  search/<reader>/text-<n>.json page key -> text, in parts loaded only by a search

Disagreement between two readings of a page = Levenshtein edits ÷ the length of
the longer reading, whitespace collapsed. It is symmetric, 0 when they agree,
and says nothing about which of the two is right: a model that invents fluent
text disagrees exactly as much as one that reads badly.
"""

from __future__ import annotations

import csv
import itertools
import json
import re
import shutil
import sys
from pathlib import Path

from rapidfuzz.distance import Levenshtein

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "site" / "data"
CHUNK = 20                     # pages per file the viewer loads at once
SEARCH_SHARD_CHARS = 1_500_000  # text per search shard, loaded in parallel
DOC = re.compile(r"^BAT_(\d+(?:\.\d+)?)_?(.*)$")


def flat(text: str) -> str:
    return " ".join(text.split())


def clean_reading(text: str) -> str:
    """Drop the empty lines a line-based engine leaves for every segment it
    could not read; keep every other line."""
    return "\n".join(line.rstrip() for line in (text or "").splitlines() if line.strip())


def load_pages() -> list[dict]:
    with (ROOT / "readings" / "pages.tsv").open(encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh, delimiter="\t"))
    for r in rows:
        r["pageNr"] = int(r["pageNr"])
    return rows


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


def doc_meta(doc: str) -> dict:
    m = DOC.match(doc)
    shelf, rest = (m.group(1), m.group(2)) if m else (doc, "")
    parts = [x for x in rest.split("_") if x]
    if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():  # "500_543_und_465"
        parts = [f"{parts[0]}–{parts[1]}"] + parts[2:]
    rng = " ".join(parts)                                                # "500–543 und 465", "1–99 neu"
    return {"shelf": shelf, "range": rng}


def write_search(pages: list[dict], readings: dict[str, dict[str, dict]], readers: list[str]) -> dict[str, int]:
    out = OUT / "search"
    shards_of: dict[str, int] = {}
    for reader in readers:
        folder = out / reader
        folder.mkdir(parents=True, exist_ok=True)
        shards, cur, size = [], {}, 0
        for p in pages:
            text = readings[reader].get(p["key"], {}).get("text")
            if not text:
                continue
            cur[p["key"]] = text
            size += len(text)
            if size >= SEARCH_SHARD_CHARS:
                shards.append(cur); cur, size = {}, 0
        if cur:
            shards.append(cur)
        for i, shard in enumerate(shards):
            (folder / f"text-{i}.json").write_text(json.dumps(shard, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        shards_of[reader] = len(shards)
    return shards_of


def main() -> None:
    pages = load_pages()
    keys = {p["key"] for p in pages}
    readings = load_readings(keys)
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

    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    pair = {(a, b): {"edits": 0, "chars": 0, "pages": 0} for a, b in itertools.combinations(ids, 2)}
    read = {r: 0 for r in ids}
    docs: dict[str, dict] = {}
    by_doc: dict[str, list[dict]] = {}
    for p in pages:
        by_doc.setdefault(p["doc"], []).append(p)
    for doc, dpages in by_doc.items():
        dpages.sort(key=lambda p: p["pageNr"])
        meta = {"id": doc, **doc_meta(doc), "pages": [p["pageNr"] for p in dpages],
                "read": {r: 0 for r in ids}, "lines": 0}
        for c in range(0, len(dpages), CHUNK):
            chunk = {}
            for p in dpages[c:c + CHUNK]:
                rec = {"key": p["key"], "lines": int(p["lines"]) if str(p.get("lines", "")).isdigit() else None,
                       "lm": p.get("pylaia_lm") or "", "readings": {}}
                meta["lines"] += rec["lines"] or 0
                for r in ids:
                    rd = readings[r].get(p["key"])
                    if rd is not None:
                        rec["readings"][r] = rd
                        read[r] += 1
                        meta["read"][r] += 1
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
                    if p["key"] in ents and r in rec["readings"]:
                        rec.setdefault("ents", {})[r] = ents[p["key"]]
                chunk[str(p["pageNr"])] = rec
            folder = OUT / "pages" / doc
            folder.mkdir(parents=True, exist_ok=True)
            (folder / f"{c // CHUNK}.json").write_text(json.dumps(chunk, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        docs[doc] = meta

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

    shards = write_search(pages, readings, ids)
    index = {"chunk": CHUNK, "pages": len(pages), "docs": list(docs.values()), "search": shards}
    (OUT / "index.json").write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (OUT / "readers.json").write_text(json.dumps(readers, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"{len(pages)} pages in {len(docs)} documents")
    for r in readers:
        print(f"  {r['id']:<40} read {r['pages_read']:>5}")
    for (a, b), t in pair.items():
        if t["pages"]:
            print(f"  disagreement {a} | {b}: {t['edits'] / t['chars']:.4f} over {t['pages']} pages")


if __name__ == "__main__":
    main()
