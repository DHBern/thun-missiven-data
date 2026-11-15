"""Import the Transkribus reading of the Thun Missiven as the first reader.

    python scripts/import_transkribus.py <manifest.jsonl> <pagexml dir>
    python scripts/import_transkribus.py            # the paths in readings/sources.json (tei)

Inputs (written by the ingest on tei, ``thun-missiven-images/``; neither is
committed here):

* ``manifest.jsonl``: one row per page of Transkribus collection 2329424 with
  ``key``, ``doc``, ``pageNr``, ``width``, ``height``, ``lines`` and the page's
  transcript history (``versions``);
* ``pagexml/<key>.xml``: the latest transcript of that page.

Outputs:

* ``readings/transkribus-pylaia-m2.4.jsonl``: one line per page that has a
  PyLaia transcript, ``{"key", "doc", "pageNr", "text"}``, the text one line per
  ``TextLine`` in reading order;
* ``readings/pages.tsv``: every page of the corpus in shelfmark order, with its
  size, line count and which PyLaia variant read it (with or without language
  model). This file defines the pages the viewer knows.

Nothing personal is carried over: the manifest names the Transkribus user of
every transcript version (an e-mail address), and only the tool name, never the
user, is read from it. ``check_public`` fails the run if an e-mail address or a
``userName``/``userId`` would end up in an output file.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path

from lxml import etree

ROOT = Path(__file__).resolve().parents[1]
READER = "transkribus-pylaia-m2.4"
EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
DOC = re.compile(r"^BAT_(\d+)(?:\.(\d+))?(?:_(\d+))?(.*)$")
# Two Transkribus titles write the sub-shelfmark with an underscore:
# "BAT_664_1_100_199" is BAT 664.1, Nr. 100-199 (not BAT 664, "1-100 199").
SUBSHELF = re.compile(r"^BAT_(\d+)_1_(\d+_\d+.*)$")


def norm_title(title: str) -> str:
    m = SUBSHELF.match(title)
    return f"BAT_{m.group(1)}.1_{m.group(2)}" if m else title



def doc_sort_key(title: str) -> tuple:
    """BAT_663_..., BAT_663.1_..., BAT_664_... then the first letter number:
    shelfmark order. Unknown titles go last, alphabetically."""
    m = DOC.match(norm_title(title))
    if not m:
        return (1 << 30, 0, 0, title)
    shelf, sub, first, rest = m.groups()
    return (int(shelf), int(sub or 0), int(first or 0), rest)


def local(el) -> str:
    return etree.QName(el).localname if isinstance(el.tag, str) else ""


RO = re.compile(r"readingOrder\s*\{\s*index:\s*(\d+)")


def ro_index(el, default: int) -> int:
    m = RO.search(el.get("custom") or "")
    return int(m.group(1)) if m else default


def line_text(tl) -> str:
    """The TextLine's own TextEquiv (not its Words'), the lowest @index."""
    equivs = [e for e in tl if local(e) == "TextEquiv"]
    if not equivs:
        words = [w for w in tl if local(w) == "Word"]
        return " ".join(line_text(w) for w in words).strip()
    best = min(equivs, key=lambda e: int(e.get("index") or 0))
    uni = next((u for u in best if local(u) == "Unicode"), None)
    return "".join(uni.itertext()) if uni is not None else ""


def from_pagexml(path: Path) -> tuple[str, str]:
    """(text, creator): every TextLine in reading order — regions by the
    ReadingOrder (else document order), lines by their readingOrder index."""
    root = etree.parse(str(path), etree.XMLParser(recover=True)).getroot()
    creator = next((el.text or "" for el in root.iter() if local(el) == "Creator"), "")
    regions = [el for el in root.iter() if local(el) == "TextRegion"]
    by_id = {r.get("id"): r for r in regions}
    refs = sorted((int(el.get("index") or 0), el.get("regionRef"))
                  for el in root.iter() if local(el) == "RegionRefIndexed")
    ordered = [by_id[r] for _, r in refs if r in by_id]
    ordered += [r for r in regions if r not in ordered]
    lines = []
    for region in ordered:
        tls = [tl for tl in region if local(tl) == "TextLine"]
        tls = sorted(enumerate(tls), key=lambda p: ro_index(p[1], p[0]))
        lines += [line_text(tl) for _, tl in tls]
    return "\n".join(lines).strip("\n"), creator


def variant(creator: str, versions: list[dict]) -> str:
    """'lm' or 'none' (PyLaia with or without a language model); '' when the
    latest transcript is not a PyLaia one."""
    m = re.search(r"PyLaia.*?lm=([\w-]+)", creator)
    if m:  # the PAGE XML says "provided" where the manifest says "LM: lm"
        return "lm" if m.group(1) == "provided" else m.group(1)
    for v in sorted(versions or [], key=lambda v: -(v.get("timestamp") or 0)):
        m = re.search(r"PyLaia.*LM:\s*([\w-]+)", v.get("toolName") or "")
        if m:
            return m.group(1)
    return ""


def check_public(paths: list[Path]) -> None:
    for p in paths:
        s = p.read_text(encoding="utf-8")
        if EMAIL.search(s) or "userName" in s or "userId" in s:
            sys.exit(f"{p}: contains an e-mail address or a user field — not written for the public repo")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("manifest", type=Path, nargs="?")
    ap.add_argument("pagexml", type=Path, nargs="?")
    ap.add_argument("--allow-shrink", action="store_true",
                    help="write even if the corpus or the reading would have fewer pages than now")
    args = ap.parse_args()
    if not args.manifest or not args.pagexml:
        src = json.loads((ROOT / "readings" / "sources.json").read_text(encoding="utf-8"))["transkribus"]
        args.manifest, args.pagexml = Path(src["manifest"]), Path(src["pagexml"])

    rows = []
    for line in args.manifest.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except ValueError:  # the ingest may be writing its last line right now
            print(f"  skipped an incomplete manifest line: {line[:60]}…", file=sys.stderr)
    rows.sort(key=lambda r: (doc_sort_key(r["doc"]), int(r["pageNr"])))
    out_dir = ROOT / "readings"
    out_dir.mkdir(exist_ok=True)
    readings, table, missing = [], [], 0
    for r in rows:
        xml = args.pagexml / f"{r['key']}.xml"
        text, creator = ("", "")
        if xml.exists():
            text, creator = from_pagexml(xml)
        else:
            missing += 1
        lm = variant(creator, r.get("versions"))
        table.append({"key": r["key"], "doc": r["doc"], "pageNr": int(r["pageNr"]),
                      "width": r.get("width") or "", "height": r.get("height") or "",
                      "lines": r.get("lines") if r.get("lines") is not None else "",
                      "pylaia_lm": lm})
        if lm and text.strip():
            readings.append({"key": r["key"], "doc": r["doc"], "pageNr": int(r["pageNr"]), "text": text})

    jsonl = out_dir / f"{READER}.jsonl"
    tsv = out_dir / "pages.tsv"
    before_pages = max(0, len(tsv.read_text(encoding="utf-8").splitlines()) - 1) if tsv.exists() else 0
    before_read = len(jsonl.read_text(encoding="utf-8").splitlines()) if jsonl.exists() else 0
    if not args.allow_shrink and (len(table) < before_pages or len(readings) < before_read):
        sys.exit(f"would shrink: pages {before_pages} -> {len(table)}, read {before_read} -> {len(readings)}; nothing written")
    jsonl.write_text("".join(json.dumps(x, ensure_ascii=False) + "\n" for x in readings), encoding="utf-8")
    with tsv.open("w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(table[0]), delimiter="\t", lineterminator="\n")
        w.writeheader()
        w.writerows(table)
    check_public([jsonl, tsv])
    docs = len({r["doc"] for r in table})
    read = {x["key"] for x in readings}
    lm = sum(1 for r in table if r["key"] in read and r["pylaia_lm"] == "lm")
    none = sum(1 for r in table if r["key"] in read and r["pylaia_lm"] == "none")
    print(f"{len(table)} pages in {docs} documents; {len(readings)} with a PyLaia reading "
          f"({lm} with LM, {none} without); {missing} without PAGE XML")


if __name__ == "__main__":
    main()
