"""Combined tagging: hmBERT and qwen3.8 propose, gpt-oss-120b decides (St. Gallen's method).

    set -a; . ~/.gpustack.env; set +a
    python scripts/ner_llm.py --n 20          # a sample
    python scripts/ner_llm.py                 # every page not yet tagged, or whose reading changed

The method of DHBern/sg-missiven-data scripts/ner_llm.py ("combined"), which there beat
both taggers alone on the late letters (F1 all 0.713 against hmBERT 0.677; persons 0.714,
organisations 0.775, places 0.750; docs/NER.md):

1. hmBERT, trained on the St. Gallen edition, has tagged the page already
   (entities/hmbert/gemini-4-argon.jsonl, from ops/asteraix/thun_ner.py).
2. Qwen3.8-27B (GPUStack, no thinking) tags the page with the edition's ten labels, with
   six pages of three St. Gallen letters from Schultheiss und Rat zu Bern as examples
   (prompts/ner_examples_sg.json). It quotes each name; the script finds the quote.
3. gpt-oss-120b (GPUStack, reasoning low) sees both taggers' proposals with who made them,
   the page and the letter's year, and decides per proposal: keep or drop, label and role.
   Unlike St. Gallen it does not link: Thun has no register to choose from. The register
   is generated from these tags afterwards (scripts/register.py).

Nothing here is measured on Thun: there is no Thun gold sample yet (docs/NER_PLAN.md, N-1).

Output: ``THM_NER_OUT`` (default entities/combined/gemini-4-argon.jsonl), one record per
page in the format of entities/: {"key", "auto", "unedited", "year", "method": "combined",
"input_digest", "entities": [{"type", "el", "role"?, "start", "end", "text", "by", "when"?}]}.
Calls are cached in ner_llm/.cache/ (not committed).
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
READER = "gemini-4-argon"
TAGGER = "qwen3.8-27b"
JUDGE = "gpt-oss-120b"
CACHE = Path(os.environ.get("THM_NER_CACHE") or ROOT / "ner_llm" / ".cache")
OUT = Path(os.environ.get("THM_NER_OUT") or ROOT / "entities" / "combined" / f"{READER}.jsonl")
HMBERT = ROOT / "entities" / "hmbert" / f"{READER}.jsonl"
TYPES = ["persName", "persName@issuer", "persName@recipient", "orgName", "orgName@issuer",
         "orgName@recipient", "placeName", "origPlace", "origDate", "date"]
COARSE = {"persName": "per", "orgName": "org", "placeName": "place", "origPlace": "place",
          "origDate": "date", "date": "date"}

GUIDE = """You tag a page of a letter from the Thun Missiven (letters to the town of Thun in the Bernese
Oberland, 1400-1550, most of them from the Schultheiss and council of Bern, Early New High German,
sometimes Latin, as read by a machine, with its misreadings). Use the tag set of the St. Gallen
Missiven edition, exactly these labels:

- persName            a person named in the text (given name and/or surname, as written; without titles
                      like "her", "junckher", "meister", without offices, without "von" + place unless it is
                      part of the name as written)
- persName@issuer     a person who issues the letter: the sender named in the signature or the opening
- persName@recipient  a person the letter is addressed to: in the address or the salutation
- orgName             a group or institution: a town council, a town as political body ("die von Frutingen"),
                      the Confederates ("Eidgenossen"), a monastery, a guild
- orgName@issuer      the issuing body (e.g. "Schultheis und Rat zuo Bern" in the signature)
- orgName@recipient   the addressed body (e.g. the address "Dem ... Schultheissen und Rat zuo Thun")
- placeName           a place: town, village, valley, region, river, as a place (not as a political body)
- origPlace           the place of writing in the date line ("Geben zuo Bern ...": tag "Bern")
- origDate            the date of the date line, from the day/feast to the year ("uff mentag nach Galli
                      anno etc. lxxxiii")
- date                any other date in the text

Rules: tag only what is in the text; quote it exactly, character for character, as it stands in the page
(keep the misreadings). No nesting: a place inside an organisation's name is not tagged separately. Every
occurrence is tagged, in reading order. Roles (issuer/recipient) only in address, salutation, signature or
the opening sentence that names the sender; elsewhere the plain label. The examples are letters from Bern
to St. Gallen; in the Thun letters the recipient is usually Thun, never assume St. Gallen."""

TAG_FORMAT = """Answer with JSON only: {"entities": [{"text": "<exact quote>", "label": "<label>"}, ...]}"""

JUDGE_GUIDE = """You check proposed tags on a page of a letter from the Thun Missiven (1400-1550), using the tag set and
rules below. For each numbered proposal decide:
- keep: true by default. The page is a machine reading with misreadings: a garbled or unknown name is
  still a name. Set false ONLY when the span is clearly not a name or date at all (an ordinary word, a
  title or office alone such as "her schultheis" without a name), or when it duplicates a span that
  overlaps it. Give the reason in "why" when you set false.
- label: the correct label (see the tag set); change it if wrong, including the role.

Tag set and rules:
""" + GUIDE.split("Use the tag set of the St. Gallen\nMissiven edition, exactly these labels:\n", 1)[1]

JUDGE_FORMAT = """Answer with JSON only: {"decisions": [{"i": <number>, "keep": true|false, "label": "<label>", "why": "<only when keep is false>"}, ...]}
One decision per proposal, in order. "label" is always one of the ten labels, also when you keep the proposal unchanged.
Proposals come from two taggers and may overlap: of overlapping proposals keep at most one, the best delimited."""
assert "persName@issuer" in JUDGE_GUIDE
PROMPT_DIGEST = hashlib.sha256((GUIDE + TAG_FORMAT + JUDGE_GUIDE + JUDGE_FORMAT).encode()).hexdigest()[:8]

CLIENT: httpx.Client | None = None


def chat(model: str, messages: list[dict], **extra) -> tuple[str, dict]:
    body = {"model": model, "messages": messages, "temperature": 0, **extra}
    ck = hashlib.sha1(json.dumps(body, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / f"{ck}.json"
    if f.exists():
        d = json.loads(f.read_text())
        return d["content"], d["usage"]
    for attempt in range(5):
        try:
            t0 = time.time()
            r = CLIENT.post("/chat/completions", json=body)
            r.raise_for_status()
            d = r.json()
            content = d["choices"][0]["message"].get("content") or ""
            usage = {**(d.get("usage") or {}), "seconds": round(time.time() - t0, 1),
                     "finish": d["choices"][0].get("finish_reason")}
            f.write_text(json.dumps({"content": content, "usage": usage}, ensure_ascii=False))
            return content, usage
        except Exception as exc:  # noqa: BLE001
            if attempt == 4:
                raise
            print(f"  {model}: {str(exc)[:120]} (retry)", file=sys.stderr)
            time.sleep(15 * (attempt + 1))
    raise RuntimeError("unreachable")


def parse_json(text: str) -> dict:
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
    for cand in (text, (re.search(r"\{.*\}", text, re.S) or [None])[0]):
        if not cand:
            continue
        try:
            return json.loads(cand, strict=False)
        except ValueError:
            continue
    return {"_unreadable": True}


def locate(text: str, quotes: list[tuple[str, str]]) -> tuple[list[dict], int]:
    """Exact quotes -> spans, in reading order; a quote not found is dropped."""
    out, missed, cursor = [], 0, 0
    for q, label in quotes:
        q = q.strip()
        if not q or label not in TYPES:
            missed += 1
            continue
        i = text.find(q, cursor)
        if i < 0:
            i = text.find(q)
        if i < 0:
            rx = re.compile(r"\s+".join(map(re.escape, q.split())))
            m = rx.search(text, cursor) or rx.search(text)
            if not m:
                missed += 1
                continue
            i, j = m.start(), m.end()
        else:
            j = i + len(q)
        if any(not (j <= x["start"] or i >= x["end"]) for x in out):
            continue
        out.append({"start": i, "end": j, "text": text[i:j], "type": label})
        cursor = j
    out.sort(key=lambda x: x["start"])
    return out, missed


def shots() -> list[dict]:
    ex = json.loads((ROOT / "prompts" / "ner_examples_sg.json").read_text(encoding="utf-8"))["examples"]
    msgs = []
    for e in ex:
        msgs.append({"role": "user", "content": e["text"]})
        msgs.append({"role": "assistant", "content": json.dumps({"entities": e["entities"]}, ensure_ascii=False)})
    return msgs


def tag(text: str, examples: list[dict]) -> tuple[list[dict], dict]:
    msgs = [{"role": "system", "content": GUIDE + "\n\n" + TAG_FORMAT}, *examples, {"role": "user", "content": text}]
    content, usage = chat(TAGGER, msgs, max_tokens=3000, chat_template_kwargs={"enable_thinking": False})
    data = parse_json(content)
    quotes = [(e.get("text", ""), e.get("label", "")) for e in data.get("entities", []) if isinstance(e, dict)]
    spans, missed = locate(text, quotes)
    return spans, {"proposed": len(quotes), "missed": missed, "unreadable": int(bool(data.get("_unreadable")))}


def union(hm: list[dict], qw: list[dict]) -> list[dict]:
    out = {}
    for src, spans in (("hmBERT", hm), ("qwen3.8", qw)):
        for x in spans:
            k = (x["start"], x["end"])
            if k in out:
                out[k]["by"] += f"+{src}" + (f" as {x['type']}" if out[k]["type"] != x["type"] else "")
            else:
                out[k] = {"start": x["start"], "end": x["end"], "text": x["text"], "type": x["type"], "by": src,
                          **({"when": x["when"]} if x.get("when") else {})}
    return sorted(out.values(), key=lambda x: (x["start"], x["end"]))


def judge(text: str, year: int | None, spans: list[dict]) -> tuple[list[dict], dict]:
    lines = []
    for i, x in enumerate(spans):
        ctx = text[max(0, x["start"] - 60): x["end"] + 60].replace("\n", " / ")
        lines.append(f'{i}. "{x["text"]}" proposed {x["type"]} (by {x["by"]})   context: …{ctx}…')
    user = (f"Letter year: {year or 'unknown'}\n\nPage:\n{text}\n\nProposals:\n" + ("\n".join(lines) if lines else "(none)"))
    if not spans:
        return [], {"decided": 0, "of": 0, "unreadable": 0}
    content, usage = chat(JUDGE, [{"role": "system", "content": JUDGE_GUIDE + "\n\n" + JUDGE_FORMAT},
                                  {"role": "user", "content": user}], max_tokens=6000, reasoning_effort="low")
    data = parse_json(content)
    dec = {d.get("i"): d for d in data.get("decisions", []) if isinstance(d, dict)}
    out = []
    for i, x in enumerate(spans):
        d = dec.get(i)
        if d is None:
            out.append(x)
            continue
        if not d.get("keep"):
            continue
        out.append({**x, "type": d.get("label") if d.get("label") in TYPES else x["type"]})
    out.sort(key=lambda x: (x["start"], -(x["end"] - x["start"])))
    kept = []
    for x in out:
        if kept and x["start"] < kept[-1]["end"]:
            continue
        kept.append(x)
    return kept, {"decided": len(dec), "of": len(spans), "unreadable": int(bool(data.get("_unreadable")))}


def entity_out(x: dict) -> dict:
    el, _, role = x["type"].partition("@")
    return {"type": COARSE[el], "el": el, **({"role": role} if role else {}), "start": x["start"], "end": x["end"],
            "text": x["text"], "by": x["by"], **({"when": x["when"]} if x.get("when") and COARSE[el] == "date" else {})}


def main() -> None:
    global CLIENT
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--n", type=int)
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()

    texts = {}
    for line in (ROOT / "readings" / f"{READER}.jsonl").read_text(encoding="utf-8").splitlines():
        if line.strip():
            r = json.loads(line)
            t = "\n".join(l for l in (r.get("text") or "").splitlines() if l.strip())
            if t:
                texts[r["key"]] = t
    hm, years = {}, {}
    for line in HMBERT.read_text(encoding="utf-8").splitlines():
        if line.strip():
            r = json.loads(line)
            years[r["key"]] = r.get("year")
            hm[r["key"]] = [{"start": e["start"], "end": e["end"], "text": e["text"],
                             "type": e["el"] + ("@" + e["role"] if e.get("role") else ""),
                             **({"when": e["when"]} if e.get("when") else {})}
                            for e in r.get("entities", []) if e.get("el")]
    order = []
    with (ROOT / "readings" / "letters.tsv").open(encoding="utf-8") as fh:
        for lt in csv.DictReader(fh, delimiter="\t"):
            order += [k for k in lt["pages"].split(";") if k in texts and k not in order]
    order += sorted(k for k in texts if k not in set(order))

    done = {}
    if OUT.exists():
        for line in OUT.read_text(encoding="utf-8").splitlines():
            if line.strip():
                r = json.loads(line)
                done[r["key"]] = r
    jobs = []
    for k in order:
        if a.only and k not in a.only:
            continue
        dg = hashlib.sha256((texts[k] + json.dumps(hm.get(k, []), sort_keys=True)).encode()).hexdigest()[:12]
        old = done.get(k)
        if old and "error" not in old and old.get("input_digest") == dg and old.get("prompt") == PROMPT_DIGEST:
            continue
        jobs.append((k, dg))
    if a.n:
        jobs = jobs[: a.n]
    print(f"{len(jobs)} pages: {TAGGER} tags, {JUDGE} decides (prompt {PROMPT_DIGEST}); {len(done)} already there",
          flush=True)
    if not jobs:
        return
    CLIENT = httpx.Client(base_url=os.environ.get("GPUSTACK_BASE_URL", "https://gpustack.unibe.ch/v1"), timeout=900,
                          headers={"Authorization": f"Bearer {os.environ['GPUSTACK_API_KEY']}"})
    examples = shots()

    def one(job):
        k, dg = job
        rec = {"key": k, "auto": True, "unedited": True, "year": years.get(k), "method": "combined",
               "tagger": TAGGER, "judge": JUDGE, "prompt": PROMPT_DIGEST, "input_digest": dg}
        try:
            qw, u1 = tag(texts[k], examples)
            kept, u2 = judge(texts[k], years.get(k), union(hm.get(k, []), qw))
        except Exception as e:  # noqa: BLE001
            return {**rec, "error": f"{type(e).__name__}: {str(e)[:200]}"}
        return {**rec, "entities": [entity_out(x) for x in kept], "stats": {**u1, **u2}}

    OUT.parent.mkdir(parents=True, exist_ok=True)
    t0, errors = time.time(), 0
    with ThreadPoolExecutor(a.workers) as ex, OUT.open("a", encoding="utf-8") as fh:
        for i, rec in enumerate(ex.map(one, jobs), 1):
            errors += "error" in rec
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
            fh.flush()
            if i % 25 == 0 or i == len(jobs):
                print(f"  {i}/{len(jobs)} pages, {errors} errors, {time.time() - t0:.0f} s", flush=True)


if __name__ == "__main__":
    main()
