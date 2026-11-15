"""Collect every machine reading of the Thun Missiven into readings/<reader>.jsonl, on tei.

    python3 scripts/collect_series.py [--sources readings/sources.json] [--dry-run]
    python3 scripts/collect_series.py --run <run dir> [--run ...] [--jsonl <file> --reader <id>]

Reads the sources named in ``readings/sources.json`` (atr-batch run directories
and jsonl files, see docs/PIPELINE.md), or the ones given on the command line,
and **merges** them into the readings already in the repository: a page already
there is updated when a source has it, a page no source has is kept. A reader's
page count can therefore only grow; if a reader would lose pages, nothing is
written and the script fails.

A page is keyed by its Transkribus page key, ``<doc title>_p<4-digit pageNr>``,
which is also the stem of the image the runs read (``pages/<key>.jpg``). Only
keys listed in ``readings/pages.tsv`` are taken; the Transkribus reading itself
comes from ``scripts/import_transkribus.py``, not from here.

A record that failed (``status: failed`` or an ``error``) is skipped, so a run
that hit a rate limit leaves the page unread rather than empty. Standard library
only, so it runs with tei's system Python.
"""

from __future__ import annotations

import argparse
import csv
import glob
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ID = re.compile(r"^(?!lines$)[a-z0-9][a-z0-9._-]*$")  # "lines": readings/lines.jsonl is the line geometry


def page_keys() -> dict[str, str]:
    """lower-case key -> key, in shelfmark order."""
    with (ROOT / "readings" / "pages.tsv").open(encoding="utf-8") as fh:
        return {r["key"].lower(): r["key"] for r in csv.DictReader(fh, delimiter="\t")}


def key_for(name: str, keys: dict[str, str]) -> str | None:
    stem = Path(name).name
    for _ in range(2):  # "<key>.jpg.txt" -> "<key>"
        stem = re.sub(r"\.(txt|json|xml|jpe?g|png|tiff?)$", "", stem, flags=re.I)
    return keys.get(stem.lower())


def failed(rec: dict) -> bool:
    return rec.get("status") == "failed" or bool(rec.get("error"))


def from_runs(run_dirs: list[Path], keys: dict[str, str], readers: dict[str, dict[str, dict]]) -> None:
    for rdir in run_dirs:
        if not rdir.is_dir():
            print(f"  run not found: {rdir}", file=sys.stderr)
            continue
        # a run dir holds one folder per model; a model folder may be given directly
        mdirs = [p for p in rdir.iterdir() if p.is_dir() and p.name != "tmp"] or [rdir]
        for mdir in sorted(mdirs):
            n = skipped = 0
            for path in mdir.glob("*.json"):
                try:
                    rec = json.loads(path.read_text(encoding="utf-8"))
                except (ValueError, UnicodeDecodeError):
                    continue
                if not isinstance(rec, dict) or rec.get("schema") != "atr-batch/1":
                    continue
                key = key_for(path.stem, keys)
                if not key:
                    skipped += 1
                    continue
                if failed(rec):
                    continue
                readers.setdefault(rec["model"], {})[key] = {
                    "key": key, "text": rec.get("text") or "", "truncated": bool(rec.get("truncated")),
                    "segmented_by": rec.get("segmented_by"), "gateway_version": rec.get("gateway_version"),
                    "settings": rec.get("settings"), "run": mdir.parent.name if mdir != rdir else rdir.parent.name}
                n += 1
            print(f"  {mdir.parent.name}/{mdir.name}: {n} pages" + (f" ({skipped} not in pages.tsv)" if skipped else ""))


def from_jsonl(specs: list[dict], keys: dict[str, str], readers: dict[str, dict[str, dict]]) -> None:
    for spec in specs:
        n = 0
        for path in sorted(glob.glob(spec["glob"])):
            for line in Path(path).read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                rec = json.loads(line)
                if rec.get("text") is None or failed(rec):
                    continue
                key = key_for(rec["key"], keys)
                if not key:
                    continue
                reader = spec.get("reader") or Path(path).parent.name  # ubelix/<model>/*.jsonl
                readers.setdefault(reader, {})[key] = {
                    "key": key, "text": rec["text"], "truncated": bool(rec.get("truncated")),
                    "settings": rec.get("settings"), "run": Path(path).parent.name}
                n += 1
        print(f"  {spec.get('reader') or '<model dir>'} (jsonl {spec['glob']}): {n} pages")


def merge(found: dict[str, dict[str, dict]], keys: dict[str, str], dry_run: bool) -> None:
    order = {k: i for i, k in enumerate(keys.values())}
    plan = {}
    for reader, pages in sorted(found.items()):
        if not ID.match(reader):
            sys.exit(f"reader id {reader!r}: use lower case letters, digits, '.', '-', '_'")
        path = ROOT / "readings" / f"{reader}.jsonl"
        old = {}
        if path.exists():
            for line in path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    r = json.loads(line)
                    old[r["key"]] = r
        merged = {**old, **pages}
        if len(merged) < len(old):
            sys.exit(f"{reader}: would shrink from {len(old)} to {len(merged)} pages; nothing written")
        added = len(set(pages) - set(old))
        changed = sum(1 for k in set(pages) & set(old) if pages[k].get("text") != old[k].get("text"))
        plan[reader] = (path, merged, len(old), added, changed)
    for reader, (path, merged, before, added, changed) in plan.items():
        print(f"{reader}: {before} -> {len(merged)} pages (+{added} new, {changed} changed)")
        if dry_run:
            continue
        rows = sorted(merged.values(), key=lambda r: (order.get(r["key"], 1 << 30), r["key"]))
        path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    known = {r["id"] for r in json.loads((ROOT / "readings" / "readers.json").read_text(encoding="utf-8"))}
    for reader in plan:
        if reader not in known:
            print(f"  next: describe {reader} in readings/readers.json — a reader not listed there is not shown")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sources", default=str(ROOT / "readings" / "sources.json"))
    ap.add_argument("--run", action="append", type=Path, help="an atr-batch run dir (or one model folder of it); overrides --sources")
    ap.add_argument("--jsonl", action="append", help="a jsonl file or glob of {key, text}; needs --reader")
    ap.add_argument("--reader", help="reader id for --jsonl")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    keys = page_keys()
    found: dict[str, dict[str, dict]] = {}
    if a.run or a.jsonl:
        if a.jsonl and not a.reader:
            sys.exit("--jsonl needs --reader <id>")
        from_runs(a.run or [], keys, found)
        from_jsonl([{"glob": g, "reader": a.reader} for g in a.jsonl or []], keys, found)
    else:
        cfg = json.loads(Path(a.sources).read_text(encoding="utf-8"))
        vlm_test = Path(cfg["vlm_test"])
        from_runs([vlm_test / r for r in cfg.get("runs", [])], keys, found)
        from_jsonl(cfg.get("jsonl", []), keys, found)
    merge(found, keys, a.dry_run)


if __name__ == "__main__":
    main()
