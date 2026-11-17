"""Give every letter one to four keywords from this collection's own vocabulary.

    set -a; . ~/.gpustack.env; set +a
    python scripts/keywords.py --n 20      # a sample
    python scripts/keywords.py             # every letter whose regest has no keywords yet, or changed

The vocabulary (keywords/vocabulary.json) was made for the Thun Missiven from
a reading of their regest drafts; it is not borrowed from another edition. A
letter's regest draft and its date line go to Qwen3.8-27B on the University
of Bern's GPUStack with the vocabulary (id, label, definition). The model
answers with keyword ids only; ids not in the vocabulary are dropped. It may
also name one topic the vocabulary lacks: those proposals are collected in
keywords/proposals.tsv, to extend the vocabulary by hand.

A letter is assigned again when its regest changes (a new reading, a new
draft) or the vocabulary gets a new version.

Output: keywords/assigned.jsonl, one line per letter (the latest wins):
{"id", "keywords": [...], "proposal", "regest_digest", "vocabulary", "model"}
Everything here is a machine assignment from a machine draft; the viewer says so.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
MODEL = "qwen3.8-27b"
VOCAB = json.loads((ROOT / "keywords" / "vocabulary.json").read_text(encoding="utf-8"))
KEYWORDS = {k["id"]: k for g in VOCAB["groups"] for k in g["keywords"]}
OUT = ROOT / "keywords" / "assigned.jsonl"

SYSTEM = ("Du ordnest Briefe aus dem Burgerarchiv Thun (15. und 16. Jahrhundert) Schlagwörtern zu. "
          "Du bekommst das Regest eines Briefs (ein maschineller Entwurf) und wählst aus der Liste unten "
          "ein bis vier Schlagwörter, die sein Thema treffen: das Hauptthema zuerst, dann was im Brief "
          "wirklich verhandelt wird, nicht was nur nebenbei vorkommt. Wähle nur Kennungen aus der Liste. "
          "«befehl» nur, wenn Bern etwas anordnet oder verbietet, nicht für jede Bitte. "
          "Fehlt in der Liste ein Thema, das für diesen Brief wichtig ist, nenne es in «neu» "
          "(zwei bis vier Wörter), sonst null.\n\n"
          "Antworte ausschliesslich mit JSON: {\"keywords\": [\"kennung\", ...], \"neu\": \"...\" oder null}\n\n"
          "Schlagwörter (Kennung: Bezeichnung – Bedeutung):\n" +
          "\n".join(f"{g['de']}:\n" + "\n".join(f"  {k['id']}: {k['de']} – {k['def']}" for k in g["keywords"])
                    for g in VOCAB["groups"]))
PROMPT_DIGEST = hashlib.sha256(SYSTEM.encode()).hexdigest()[:8]


def drafts() -> dict[str, dict]:
    out = {}
    for line in (ROOT / "regests" / "drafts.jsonl").read_text(encoding="utf-8").splitlines():
        if line.strip():
            r = json.loads(line)
            if "error" not in r["draft"] and (r["draft"].get("regest") or "").strip():
                out[r["id"]] = r
    return out


def regest_input(r: dict) -> str:
    d = r["draft"]
    parts = [f"Überschrift: {r.get('heading') or ''}".strip(), f"Regest: {d['regest'].strip()}"]
    if d.get("date_text"):
        parts.append(f"Datumszeile: {d['date_text']}")
    return "\n".join(parts)


def digest(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:12]


def ask(client: httpx.Client, text: str) -> dict:
    body = {"model": MODEL, "temperature": 0.1, "max_tokens": 300,
            "chat_template_kwargs": {"enable_thinking": False},
            "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": text}]}
    last: Exception | None = None
    for attempt in range(4):
        try:
            r = client.post("/chat/completions", json=body)
            r.raise_for_status()
            content = r.json()["choices"][0]["message"]["content"] or ""
            m = re.search(r"\{.*\}", content, re.S)
            answer = json.loads(m.group(0) if m else content)
            kws = [k for k in answer.get("keywords") or [] if k in KEYWORDS]
            kws = list(dict.fromkeys(kws))[:4]
            if not kws and attempt < 3:
                last = ValueError(f"no known keyword in {answer.get('keywords')}")
                continue
            neu = answer.get("neu")
            return {"keywords": kws, "proposal": neu.strip() if isinstance(neu, str) and neu.strip() else None,
                    "dropped": [k for k in answer.get("keywords") or [] if k not in KEYWORDS] or None}
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(4 * (attempt + 1))
    return {"error": str(last)[:300]}


def write_proposals(rows: dict[str, dict]) -> int:
    c = Counter(re.sub(r"\s+", " ", r["proposal"].strip().lower()) for r in rows.values() if r.get("proposal"))
    with (ROOT / "keywords" / "proposals.tsv").open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh, delimiter="\t", lineterminator="\n")
        w.writerow(["proposal", "letters", "examples"])
        for p, n in c.most_common():
            ex = [i for i, r in rows.items() if (r.get("proposal") or "").strip().lower() == p][:5]
            w.writerow([p, n, " ".join(ex)])
    return len(c)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=None)
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()

    done: dict[str, dict] = {}
    if OUT.exists():
        for line in OUT.read_text(encoding="utf-8").splitlines():
            if line.strip():
                r = json.loads(line)
                done[r["id"]] = r
    jobs = []
    for lid, r in drafts().items():
        if args.only and lid not in args.only:
            continue
        text = regest_input(r)
        old = done.get(lid)
        if old and "error" not in old and old.get("regest_digest") == digest(text) \
                and old.get("vocabulary") == VOCAB["version"] and old.get("prompt") == PROMPT_DIGEST:
            continue
        jobs.append((lid, text))
    if args.n:
        jobs = jobs[: args.n]
    print(f"{len(jobs)} letters to assign via {MODEL} (vocabulary v{VOCAB['version']}, {len(KEYWORDS)} keywords, "
          f"prompt {PROMPT_DIGEST})", flush=True)
    if jobs:
        base = os.environ.get("GPUSTACK_BASE_URL", "https://gpustack.unibe.ch/v1")
        key = os.environ["GPUSTACK_API_KEY"]
        with httpx.Client(base_url=base, headers={"Authorization": f"Bearer {key}"}, timeout=180) as client, \
                ThreadPoolExecutor(args.workers) as pool, OUT.open("a", encoding="utf-8") as fh:
            for i, ((lid, text), a) in enumerate(zip(jobs, pool.map(lambda j: ask(client, j[1]), jobs)), 1):
                row = {"id": lid, **a, "regest_digest": digest(text), "vocabulary": VOCAB["version"],
                       "prompt": PROMPT_DIGEST, "model": MODEL, "machine": True}
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
                fh.flush()
                done[lid] = row
                if i % 50 == 0 or i == len(jobs):
                    print(f"  {i}/{len(jobs)}", flush=True)
    ok = {i: r for i, r in done.items() if "error" not in r}
    c = Counter(k for r in ok.values() for k in r["keywords"])
    n_prop = write_proposals(ok)
    print(f"{len(ok)} letters with keywords; most frequent: {c.most_common(10)}; {n_prop} proposals", flush=True)


if __name__ == "__main__":
    main()
