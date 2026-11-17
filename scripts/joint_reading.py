"""The joint reading: one text per page, written by a vision model from the image and the machine readings.

    set -a; . ~/.gpustack.env; set +a
    python scripts/joint_reading.py run  --images DIR [--images DIR2] [--keys keys.txt] [--n 20]
    python scripts/joint_reading.py eval --images DIR --readings-dir DIR --edition edition.json --keys keys.txt

Qwen3.8-27B on the University of Bern's GPUStack (vision, no thinking) gets the page image
and the independent machine readings of that page:

    A  Gemini 4 Argon          (whole page, the best single reading here)
    B  Gemini 3.8 Flash        (whole page)
    C  Transkribus PyLaia M2.4 (line by line, after Transkribus' layout analysis)

and writes the page once, word for word as written, choosing at every place the reading the
image supports. It keeps A's line division, so the joint reading can be laid over the lines
like the others. Guards: an answer much shorter or longer than A (a loop or a stop), or an
empty one, falls back to A and says so in ``fallback``.

The St. Gallen Missiven found that neither a weighted vote of readers nor a vision model
revising the uncertain words beat Argon alone (sg-missiven-data docs/PIPELINE.md,
scripts/revise_joint.py). Thun has no edition to measure against, so ``eval`` runs the same
method on edited St. Gallen pages (Argon, Flash and a kraken line reader standing in for
PyLaia) and prints the CER of each reader and of the joint reading against the edition.

``run`` writes ``readings/joint-qwen3.8.jsonl`` (or ``THM_JOINT_OUT``): key, text,
readers used, model, prompt digest, input digest, fallback. A rerun skips pages whose
inputs are unchanged.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODEL = "qwen3.8-27b"
MAX_SIDE = 2048
READERS = [("A", "gemini-4-argon"), ("B", "gemini-3.8-flash"), ("C", "transkribus-pylaia-m2.4")]
LENGTH_GUARD = (0.6, 1.5)
OUT = Path(os.environ.get("THM_JOINT_OUT") or ROOT / "readings" / "joint-qwen3.8.jsonl")

PROMPTS = {
    # v1: A named as usually the best. On 60 edited St. Gallen pages the model copied A (0.1 % changed).
    "v1": """You see the image of one page of a letter (15th–16th century, Early New High German, sometimes Latin) and up to three machine transcriptions of it, A, B and C. Each has errors; A is usually the best.
Write the text of the page exactly as it is written in the image, using the transcriptions as help: at every place where they differ, look at the image and take the reading the image supports, or your own reading if none of them is right.
Rules:
- Keep the old spelling, abbreviations and letters as written (u/v, i/j, y, w, ů, ä, ß, superscript vowels); do not modernise, normalise, expand or translate.
- Keep the line division of A: one output line for each line of A, in the same order. Add a line only if A missed a line that is clearly on the page.
- Nothing that is not on the page: no headings, notes or comments.
Answer with the text of the page only.""",
    # v2: no reader preferred; the image decides every word.
    "v2": """You see the image of one page of a letter (15th–16th century, Early New High German, sometimes Latin) and up to three independent machine transcriptions of it, A, B and C. Every one of them has misread words, and none is reliable.
Your task is to transcribe the page from the image. Go through the page line by line. For every word, read it in the image; the transcriptions only show you what other readers saw. Where they disagree, the image decides. Where all of them agree but the image shows something else, write what the image shows.
Rules:
- Keep the old spelling, abbreviations and letters as written (u/v, i/j, y, w, ů, ä, ß, superscript vowels); do not modernise, normalise, expand or translate.
- One output line for each line of A, in the same order (A's line division is used to lay the text over the image). Add a line only if A missed a line that is clearly on the page.
- Nothing that is not on the page: no headings, notes or comments.
Answer with the text of the page only.""",
}
PROMPT_VERSION = os.environ.get("THM_JOINT_PROMPT", "v2")
PROMPT = PROMPTS[PROMPT_VERSION]
PROMPT_DIGEST = hashlib.sha256(PROMPT.encode()).hexdigest()[:8]


def load(path: Path) -> dict[str, str]:
    out = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            r = json.loads(line)
            t = "\n".join(l for l in (r.get("text") or "").splitlines() if l.strip())
            if t:
                out[r["key"]] = t
    return out


def image_b64(key: str, dirs: list[Path]) -> str | None:
    from PIL import Image
    stem = key.rsplit(".", 1)[0] if key.lower().endswith((".jpg", ".jpeg", ".png")) else key
    for d in dirs:
        for ext in (".jpg", ".JPG", ".jpeg", ".png"):
            hits = [d / (stem + ext)] + list(d.glob(f"*/{stem}{ext}"))
            for p in hits:
                if p.exists():
                    im = Image.open(p).convert("RGB")
                    im.thumbnail((MAX_SIDE, MAX_SIDE))
                    buf = io.BytesIO()
                    im.save(buf, "JPEG", quality=88)
                    return base64.b64encode(buf.getvalue()).decode()
    return None


def user_text(readings: list[tuple[str, str]]) -> str:
    return "\n\n".join(f"Transcription {code}:\n{text}" for code, text in readings)


def ask(client, img: str, text: str) -> str:
    body = {"model": MODEL, "temperature": 0, "max_tokens": 6000,
            "chat_template_kwargs": {"enable_thinking": False},
            "messages": [{"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{img}"}},
                {"type": "text", "text": PROMPT + "\n\n" + text}]}]}
    for attempt in range(4):
        try:
            r = client.post("/chat/completions", json=body)
            r.raise_for_status()
            return (r.json()["choices"][0]["message"]["content"] or "").strip()
        except Exception as e:  # noqa: BLE001  (network, gateway)
            if attempt == 3:
                raise
            print(f"  retry after {type(e).__name__}: {str(e)[:120]}", file=sys.stderr)
            time.sleep(10 * (attempt + 1))
    return ""


def clean(answer: str) -> str:
    answer = re.sub(r"^```\w*\n|\n```$", "", answer.strip())
    return "\n".join(l.rstrip() for l in answer.splitlines() if l.strip())


def flat(s: str) -> str:
    return " ".join(s.split())


def joint_one(client, key: str, by_reader: dict[str, dict[str, str]], dirs: list[Path]) -> dict:
    readings = [(code, by_reader[rid][key]) for code, rid in READERS if key in by_reader.get(rid, {})]
    used = [rid for code, rid in READERS if key in by_reader.get(rid, {})]
    base = by_reader.get(READERS[0][1], {}).get(key) or (readings[0][1] if readings else "")
    rec = {"key": key, "readers": used, "model": MODEL, "prompt": PROMPT_DIGEST,
           "input_digest": hashlib.sha256(user_text(readings).encode()).hexdigest()[:12], "machine": True}
    if len(readings) < 2:
        return {**rec, "text": base, "fallback": "fewer than two readings"}
    img = image_b64(key, dirs)
    if not img:
        return {**rec, "text": base, "fallback": "no image"}
    try:
        text = clean(ask(client, img, user_text(readings)))
    except Exception as e:  # noqa: BLE001
        return {**rec, "error": f"{type(e).__name__}: {str(e)[:200]}"}
    ratio = len(flat(text)) / max(1, len(flat(base)))
    if not text or not LENGTH_GUARD[0] <= ratio <= LENGTH_GUARD[1]:
        return {**rec, "text": base, "fallback": f"length ratio {ratio:.2f}"}
    return {**rec, "text": text, "fallback": None}


def cer(a: str, b: str) -> float:
    from rapidfuzz.distance import Levenshtein
    return Levenshtein.distance(flat(a), flat(b)) / max(1, len(flat(b)))


def main() -> None:
    import httpx
    global READERS
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mode", choices=["run", "eval"])
    ap.add_argument("--images", action="append", required=True, type=Path)
    ap.add_argument("--keys", type=Path)
    ap.add_argument("--readings-dir", type=Path, default=ROOT / "readings")
    ap.add_argument("--readers", help="eval: comma-separated reader ids for A,B,C")
    ap.add_argument("--edition", type=Path)
    ap.add_argument("--n", type=int)
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()
    if a.readers:
        READERS = list(zip("ABC", a.readers.split(",")))

    by_reader = {rid: load(a.readings_dir / f"{rid}.jsonl") for _, rid in READERS}
    if a.keys:
        keys = [l.strip() for l in a.keys.read_text().splitlines() if l.strip()]
    else:
        keys = sorted(set().union(*[set(v) for v in by_reader.values()]))
    out_path = OUT if a.mode == "run" else Path(os.environ.get("THM_JOINT_EVAL_OUT", "joint_eval.jsonl"))
    done = {}
    if out_path.exists():
        for line in out_path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                r = json.loads(line)
                done[r["key"]] = r
    todo = []
    for k in keys:
        readings = [(c, by_reader[rid][k]) for c, rid in READERS if k in by_reader[rid]]
        dg = hashlib.sha256(user_text(readings).encode()).hexdigest()[:12]
        old = done.get(k)
        if old and "error" not in old and old.get("input_digest") == dg and old.get("prompt") == PROMPT_DIGEST:
            continue
        todo.append(k)
    if a.n:
        todo = todo[: a.n]
    print(f"{a.mode}: {len(todo)} pages via {MODEL} (prompt {PROMPT_DIGEST}), {len(done)} already there", flush=True)
    client = httpx.Client(base_url=os.environ.get("GPUSTACK_BASE_URL", "https://gpustack.unibe.ch/v1"), timeout=600,
                          headers={"Authorization": f"Bearer {os.environ['GPUSTACK_API_KEY']}"})
    out_path.parent.mkdir(parents=True, exist_ok=True)
    errors = 0
    with ThreadPoolExecutor(a.workers) as ex, out_path.open("a", encoding="utf-8") as fh:
        for i, rec in enumerate(ex.map(lambda k: joint_one(client, k, by_reader, a.images), todo), 1):
            errors += "error" in rec
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
            fh.flush()
            done[rec["key"]] = rec
            if i % 25 == 0 or i == len(todo):
                print(f"  {i}/{len(todo)}, {errors} errors", flush=True)
    recs = [r for r in done.values() if "error" not in r and r["key"] in set(keys)]
    fb = sum(1 for r in recs if r.get("fallback"))
    print(f"{len(recs)} pages, {fb} fell back to A, {errors} errors this run")
    if a.mode == "eval":
        ed = json.loads(a.edition.read_text(encoding="utf-8"))
        rows = [r for r in recs if r["key"] in ed]
        tot = sum(len(flat(ed[r["key"]])) for r in rows)
        def corpus(get):
            from rapidfuzz.distance import Levenshtein
            return sum(Levenshtein.distance(flat(get(r) or ""), flat(ed[r["key"]])) for r in rows) / tot
        for code, rid in READERS:
            print(f"  {code} {rid:45s} CER {corpus(lambda r: by_reader[rid].get(r['key'])):.4f}")
        print(f"  joint ({MODEL}){'':30s} CER {corpus(lambda r: r['text']):.4f}")
        base = READERS[0][1]
        better = sum(cer(r["text"], ed[r["key"]]) < cer(by_reader[base][r["key"]], ed[r["key"]]) for r in rows)
        worse = sum(cer(r["text"], ed[r["key"]]) > cer(by_reader[base][r["key"]], ed[r["key"]]) for r in rows)
        print(f"  {len(rows)} pages: joint better than A on {better}, worse on {worse}")


if __name__ == "__main__":
    main()
