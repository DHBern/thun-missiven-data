"""Keywords for every letter, from the St. Gallen edition's vocabulary (automatic).

    set -a; . ~/.gpustack.env; set +a
    python scripts/keywords.py --n 20      # a sample
    python scripts/keywords.py             # every letter not yet done, or whose reading or regest changed

Both collections share one vocabulary: the 602 keywords the editors of the
St. Gallen Missiven give their letters (keywords/vocabulary.json, with how
often they use each). A language model (Qwen3.8-27B on the University of
Bern's GPUStack, no thinking) gets that vocabulary, a Thun letter's machine
reading (Gemini 4 Argon) and its regest draft, and picks keywords **from the
vocabulary only**; any other word in its answer is dropped. Three edited
St. Gallen letters of the Schultheiss and council of Bern, with the editors'
keywords, serve as examples (prompts/keyword_examples_sg.json). This is the
method of DHBern/sg-missiven-data scripts/keywords.py for that collection's
unedited letters, measured there against the editors.

Output: keywords/assigned.jsonl, one line per letter (the latest wins):
{"id", "keywords": [terms], "reader", "input_digest", "prompt", "model", "machine": true}
Every keyword is marked as automatic wherever it is shown.
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
READER = "gemini-4-argon"
MAX_CHARS = 9000
VOCAB = json.loads((ROOT / "keywords" / "vocabulary.json").read_text(encoding="utf-8"))
TERMS = {t["term"]: t["sg_count"] for t in VOCAB["terms"]}
OUT = Path(os.environ.get("THM_KEYWORDS_OUT") or ROOT / "keywords" / "assigned.jsonl")

SYSTEM = """Du verschlagwortest Briefe der Thuner Missiven (Briefe an die Stadt Thun, 15. und 16. Jahrhundert,
viele von Schultheiss und Rat zu Bern) wie die Editorinnen der St. Galler Missiven ihre Briefe.
Wähle 4 bis 12 Schlagwörter, die den Inhalt des Briefs bezeichnen: worum es geht (z.B. Schulden, Erbe,
Krieg, Rechtstag), wer handelt (z.B. Vogt, Schultheiss, Bote), was der Brief tut (z.B. Schriftliche
Antwort, Unterstützung, Klage).
Du darfst NUR Schlagwörter aus der folgenden Liste verwenden, genau so geschrieben.
Lieber weniger und sichere als viele. Der Brieftext ist eine ungeprüfte maschinelle Lesung,
das Regest ein maschineller Entwurf.

Liste der Schlagwörter (in Klammern: wie oft die St. Galler Edition sie vergibt):
{vocab}

Antworte ausschliesslich mit JSON: {{"keywords": ["...", "..."]}}""".format(
    vocab="; ".join(f"{k} ({n})" for k, n in sorted(TERMS.items(), key=lambda kv: kv[0].lower())))
PROMPT_DIGEST = hashlib.sha256(SYSTEM.encode()).hexdigest()[:8]


def user_text(text: str, regest: str | None) -> str:
    t = text if len(text) <= MAX_CHARS else text[:MAX_CHARS] + "\n[…]"
    return (f"Regest (Entwurf): {regest}\n\n" if regest else "") + f"Brief:\n{t}"


def shots() -> list[dict]:
    ex = json.loads((ROOT / "prompts" / "keyword_examples_sg.json").read_text(encoding="utf-8"))["examples"]
    out = []
    for e in ex:
        out += [{"role": "user", "content": user_text(e["text"], e["regest"])},
                {"role": "assistant", "content": json.dumps({"keywords": e["keywords"]}, ensure_ascii=False)}]
    return out


def clean(answer: dict) -> list[str]:
    lower = {k.lower(): k for k in TERMS}
    out = []
    for k in answer.get("keywords") or []:
        k = lower.get(str(k).strip().lower())
        if k and k not in out:
            out.append(k)
    return out


def ask(client: httpx.Client, examples: list[dict], text: str) -> dict:
    body = {"model": MODEL, "temperature": 0.1, "max_tokens": 400,
            "chat_template_kwargs": {"enable_thinking": False},
            "messages": [{"role": "system", "content": SYSTEM}, *examples, {"role": "user", "content": text}]}
    last: Exception | None = None
    for attempt in range(4):
        try:
            r = client.post("/chat/completions", json=body)
            r.raise_for_status()
            content = r.json()["choices"][0]["message"]["content"] or ""
            m = re.search(r"\{.*\}", content, re.S)
            answer = json.loads(m.group(0) if m else content)
            kws = clean(answer)
            if not kws and attempt < 3:
                last = ValueError(f"no known keyword in {answer.get('keywords')}")
                continue
            dropped = [k for k in answer.get("keywords") or [] if str(k).strip().lower() not in {t.lower() for t in TERMS}]
            return {"keywords": kws, "dropped": dropped or None}
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(4 * (attempt + 1))
    return {"error": str(last)[:300]}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=None)
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()

    readings = {}
    for line in (ROOT / "readings" / f"{READER}.jsonl").read_text(encoding="utf-8").splitlines():
        if line.strip():
            r = json.loads(line)
            readings[r["key"]] = r.get("text") or ""
    regests = {}
    for line in (ROOT / "regests" / "drafts.jsonl").read_text(encoding="utf-8").splitlines():
        if line.strip():
            r = json.loads(line)
            if "error" not in r["draft"]:
                regests[r["id"]] = r["draft"].get("regest")
    done: dict[str, dict] = {}
    if OUT.exists():
        for line in OUT.read_text(encoding="utf-8").splitlines():
            if line.strip():
                r = json.loads(line)
                done[r["id"]] = r
    jobs = []
    with (ROOT / "readings" / "letters.tsv").open(encoding="utf-8") as fh:
        for lt in csv.DictReader(fh, delimiter="\t"):
            if args.only and lt["id"] not in args.only:
                continue
            pages = [readings.get(k, "").strip() for k in lt["pages"].split(";")]
            text = "\n\n".join(f"[Seite {i + 1}]\n{t}" for i, t in enumerate(pages) if t)
            if not text:
                continue
            ut = user_text(text, regests.get(lt["id"]))
            dg = hashlib.sha256(ut.encode()).hexdigest()[:12]
            old = done.get(lt["id"])
            if old and "error" not in old and old.get("input_digest") == dg and old.get("prompt") == PROMPT_DIGEST:
                continue
            jobs.append((lt["id"], ut, dg))
    if args.n:
        jobs = jobs[: args.n]
    print(f"{len(jobs)} letters via {MODEL} ({len(TERMS)} terms, prompt {PROMPT_DIGEST})", flush=True)
    if jobs:
        ex = shots()
        base = os.environ.get("GPUSTACK_BASE_URL", "https://gpustack.unibe.ch/v1")
        key = os.environ["GPUSTACK_API_KEY"]
        OUT.parent.mkdir(exist_ok=True)
        with httpx.Client(base_url=base, headers={"Authorization": f"Bearer {key}"}, timeout=300) as client, \
                ThreadPoolExecutor(args.workers) as pool, OUT.open("a", encoding="utf-8") as fh:
            for i, ((lid, ut, dg), a) in enumerate(zip(jobs, pool.map(lambda j: ask(client, ex, j[1]), jobs)), 1):
                row = {"id": lid, **a, "reader": READER, "input_digest": dg, "prompt": PROMPT_DIGEST,
                       "model": MODEL, "machine": True}
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
                fh.flush()
                done[lid] = row
                if i % 50 == 0 or i == len(jobs):
                    print(f"  {i}/{len(jobs)}", flush=True)
    ok = [r for r in done.values() if "error" not in r]
    c = Counter(k for r in ok for k in r["keywords"])
    print(f"{len(ok)} letters with keywords, {len(c)} distinct terms; most frequent: {c.most_common(12)}", flush=True)


if __name__ == "__main__":
    main()
