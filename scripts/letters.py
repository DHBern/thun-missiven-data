"""Split the Transkribus documents into single letters, by the image file names.

Each Transkribus document holds about a hundred letters, recto and verso. The
scan's file name carries the letter's signature:

    BAT_666.1_500_r.png        BAT 666.1, Nr. 500, recto
    BAT_664_51_v2.png          a second verso
    BAT_666.1_556c_r.png       Nr. 556c
    BAT_666_r__00245.JPG       an older naming: side first, number after

    python scripts/letters.py sources/transkribus_images.jsonl

The input is one line per page as Transkribus lists it (written on tei by
ops/tei/tk_images.py: key, doc, pageNr, img, tk = the Transkribus file key).
Writes

    readings/letters.tsv   one row per letter, in signature order: id, shelf,
                           nr, title, pages (page keys, ';'), sides, extra
    readings/images.tsv    one row per page: key, letter, side, img, tk (the
                           IIIF identifier on files.transkribus.eu)

A letter scanned twice (the single documents BAT_666_245 etc. repeat pages
of the large volumes) keeps the volume's scans as its pages; the other scans
are listed under ``extra``. Stops if a file name does not parse.
"""

from __future__ import annotations

import csv
import json
import re
import sys
from collections import OrderedDict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NAME_A = re.compile(r"^BAT_(?P<shelf>\d+(?:\.\d+)?)_(?P<nr>\d+)\s*(?P<suf>[a-z]?)_(?P<side>[rv])(?P<seq>\d*)"
                    r"[^.]*\.(?:png|jpe?g)$", re.I)
NAME_B = re.compile(r"^BAT_(?P<shelf>\d+(?:\.\d+)?)_(?P<side>[rv])__0*(?P<nr>\d+)(?P<suf>[a-z]?)(?P<seq>\d*)"
                    r"\.(?:png|jpe?g)$", re.I)
SIDE = {"r": ("recto", "Recto"), "v": ("verso", "Verso")}


def parse(img: str) -> dict | None:
    m = NAME_A.match(img) or NAME_B.match(img)
    if not m:
        return None
    note = ""
    if re.search(r"aufgeklappt", img, re.I):
        note = "aufgeklappt"
    return {"shelf": m["shelf"], "nr": int(m["nr"]), "suf": m["suf"].lower(),
            "side": m["side"].lower() + (m["seq"] or ""), "note": note}


def shelf_key(shelf: str) -> tuple[int, int]:
    a, _, b = shelf.partition(".")
    return int(a), int(b or 0)


def is_single(doc: str) -> bool:
    """A document that holds one letter: BAT_666_245, BAT_666.1_313."""
    return re.fullmatch(r"BAT_\d+(?:\.\d+)?_\d+", doc) is not None


def main() -> None:
    src = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "sources" / "transkribus_images.jsonl")
    rows = [json.loads(line) for line in src.read_text(encoding="utf-8").splitlines() if line.strip()]
    letters: OrderedDict[str, dict] = OrderedDict()
    bad = []
    for r in rows:
        p = parse(r["img"])
        if not p:
            bad.append(r["img"])
            continue
        lid = f"{p['shelf']}_{p['nr']}{p['suf']}"
        lt = letters.setdefault(lid, {"id": lid, "shelf": p["shelf"], "nr": p["nr"], "suf": p["suf"], "scans": []})
        lt["scans"].append({**r, **p})
    if bad:
        raise SystemExit(f"{len(bad)} file names do not parse: {bad[:10]}")

    out_letters, out_images = [], []
    for lt in sorted(letters.values(), key=lambda x: (shelf_key(x["shelf"]), x["nr"], x["suf"])):
        # the main scans: a volume rather than a single-letter document, the one
        # that has the recto, and the most pages of this letter
        docs = {s["doc"] for s in lt["scans"]}
        main_doc = max(docs, key=lambda d: (not is_single(d),
                                            any(s["side"].startswith("r") for s in lt["scans"] if s["doc"] == d),
                                            sum(s["doc"] == d for s in lt["scans"])))
        pages = sorted((s for s in lt["scans"] if s["doc"] == main_doc), key=lambda s: s["pageNr"])
        extra = sorted((s for s in lt["scans"] if s["doc"] != main_doc), key=lambda s: (s["doc"], s["pageNr"]))
        title = f"BAT {lt['shelf']}, Nr. {lt['nr']}{lt['suf']}"
        out_letters.append({"id": f"bat_{lt['id'].replace('.', '-')}", "shelf": lt["shelf"],
                            "nr": f"{lt['nr']}{lt['suf']}", "title": title, "doc": main_doc,
                            "pages": ";".join(s["key"] for s in pages),
                            "sides": ";".join(s["side"] for s in pages),
                            "extra": ";".join(s["key"] for s in extra)})
        for s in pages + extra:
            out_images.append({"key": s["key"], "letter": out_letters[-1]["id"], "side": s["side"],
                               "note": s["note"] or ("weitere Aufnahme" if s in extra else ""),
                               "img": s["img"], "tk": s["tk"], "width": s["w"], "height": s["h"]})

    for name, rows_, fields in (("letters.tsv", out_letters, list(out_letters[0])),
                                ("images.tsv", out_images, list(out_images[0]))):
        with (ROOT / "readings" / name).open("w", encoding="utf-8", newline="") as fh:
            w = csv.DictWriter(fh, fields, delimiter="\t", lineterminator="\n")
            w.writeheader()
            w.writerows(rows_)
    n_pages = sum(len(x["pages"].split(";")) for x in out_letters)
    print(f"{len(out_letters)} letters, {n_pages} pages in letters, "
          f"{sum(1 for x in out_letters if x['extra'])} with further scans, {len(out_images)} images")


if __name__ == "__main__":
    main()
