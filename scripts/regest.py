"""Draft a title and a regest for every letter, from a machine reading, in the
style of the St. Gallen Missiven edition.

    set -a; . ~/.gpustack.env; set +a
    python scripts/regest.py --n 30            # a sample: the first 30 letters not yet drafted
    python scripts/regest.py                   # every letter not yet drafted from the best reading

A letter's pages (readings/letters.tsv; the reader's text, in page order) go to
an open model on the University of Bern's GPUStack (Qwen3.8-27B, no thinking),
as in St. Gallen (sg-missiven-data scripts/regest.py). The examples are three
letters of the Schultheiss and council of Bern from the St. Gallen edition,
with the editors' regests (prompts/regest_examples_sg.json): the same chancery
that wrote most of the Thun letters. The answer is JSON: sender, recipient,
place, the date line as written, the year if the letter gives one, and the
regest: "<sender> <verb> <recipient>, …", present tense, indirect speech,
30–100 words.

The reading is the best one a letter has: Gemini 4 Argon if every page was
read by it, else the Transkribus reading (PyLaia). A draft from a worse reading
is replaced once a better one is complete, so running this again after the
Argon run upgrades every draft. Nothing here is checked by a person, and there
is no edition to measure against: the viewer marks every regest as a machine
draft and names the reading it came from.

Output: regests/drafts.jsonl, one line per letter (the latest draft wins):
{"id", "title", "heading", "reader", "model", "prompt", "pages", "draft": {...}}
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
MODEL = "qwen3.8-27b"
READERS = ["gemini-4-argon", "transkribus-pylaia-m2.4"]  # best first
OUT = Path(os.environ.get("THM_REGEST_OUT") or ROOT / "regests" / "drafts.jsonl")  # tei: outside the checkout

SYSTEM = """Du bist Editorin der Thuner Missiven: Briefe an Schultheiss und Rat der Stadt Thun
aus dem 15. und 16. Jahrhundert, viele von Schultheiss und Rat zu Bern.
Du schreibst Regesten im Stil der Edition der St. Galler Missiven: Absender, Verb, Empfänger,
dann der Inhalt in indirekter Rede (Konjunktiv), Präsens, sachlich, 30 bis 100 Wörter,
heutige Schreibung der Namen (z.B. «Schultheiss und Rat zu Bern», «Schultheiss und Rat zu Thun»).
Erfinde nichts: was der Brief nicht sagt, steht nicht im Regest. Der Brieftext ist eine
ungeprüfte maschinelle Lesung und kann viele Lesefehler enthalten; Namen, die du nicht sicher
lesen kannst, gibst du so wieder, wie sie dastehen. Ist der Text so verderbt, dass du den
Inhalt nicht erkennen kannst, schreibst du das im Regest, statt zu raten.
Die Beispiele sind Briefe an St. Gallen; sie zeigen nur den Stil. Absender, Empfänger und Ort
nimmst du allein aus dem vorliegenden Brief, nie aus den Beispielen. Die Thuner Briefe sind
meist an Schultheiss und Rat zu Thun gerichtet; die Adresse steht oft auf der Rückseite
(«Den ... von Thun»). Ist kein Empfänger zu erkennen, schreibst du null.
Schreibe immer auf Deutsch.

Antworte ausschliesslich mit JSON:
{"sender": "...", "recipient": "...", "place": "Ausstellungsort oder null",
 "date_text": "die Datumszeile wörtlich, wie sie im Brief steht, oder null",
 "year": "das Jahr als Zahl, wenn der Brief es nennt (auch abgekürzt wie «anno etc. lxv» im Jahrhundert der Hand), sonst null",
 "date": "JJJJ-MM-TT nur, wenn der Brief Tag und Monat als Zahlen nennt; Heiligen- und Festtagsdatierungen NICHT umrechnen, dann null",
 "regest": "..."}"""
PROMPT_DIGEST = hashlib.sha256(SYSTEM.encode()).hexdigest()[:8]


def letters() -> list[dict]:
    with (ROOT / "readings" / "letters.tsv").open(encoding="utf-8") as fh:
        return list(csv.DictReader(fh, delimiter="\t"))


def load_reader(reader: str) -> dict[str, str]:
    path = ROOT / "readings" / f"{reader}.jsonl"
    if not path.exists():
        return {}
    out = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            r = json.loads(line)
            out[r["key"]] = r.get("text") or ""
    return out


def letter_text(pages: list[str]) -> str:
    return "\n\n".join(f"[Seite {i + 1}]\n{t.strip()}" for i, t in enumerate(pages) if t.strip())


def examples() -> list[dict]:
    data = json.loads((ROOT / "prompts" / "regest_examples_sg.json").read_text(encoding="utf-8"))
    msgs = []
    for e in data["examples"]:
        msgs.append({"role": "user", "content": f"Brief:\n{e['text']}"})
        msgs.append({"role": "assistant", "content": json.dumps(e["answer"], ensure_ascii=False)})
    return msgs


_DE = re.compile(r"\b(der|die|das|und|des|den|dem|zu|von|mit|für|wegen|bittet|bitten)\b", re.I)
_EN = re.compile(r"\b(the|and|of|to|with|for|that|requests|asks)\b", re.I)


def german(answer: dict) -> bool:
    t = answer.get("regest") or ""
    return len(_DE.findall(t)) >= len(_EN.findall(t))


# St. Gallen in a Thun letter: almost always the date "sant Gallen tag" (16 October).
_GALL = re.compile(r"gall\w*", re.I)
_GALL_DATE = re.compile(r"\W*(tag|tage|ta-|tus|abend|abent|dag|mess)", re.I)


def gallen_unsupported(answer: dict, text: str) -> bool:
    """The draft names St. Gallen as sender or recipient, but the letter mentions
    St. Gallen only as a date or not at all: copied from the St. Gallen examples
    (5 of the first 985 drafts, 15.11.2026)."""
    who = f"{answer.get('sender') or ''} {answer.get('recipient') or ''}"
    if not _GALL.search(who):
        return False
    flat = re.sub(r"\s+", " ", text)
    return not any(not _GALL_DATE.match(flat[m.end():m.end() + 8]) for m in _GALL.finditer(flat))


def drop_gallen(answer: dict) -> dict:
    for k in ("sender", "recipient"):
        if _GALL.search(answer.get(k) or ""):
            answer[k] = None
    answer["note"] = "St. Gallen als Absender/Empfänger verworfen: im Brief nicht belegt"
    return answer


def ask(client: httpx.Client, shots: list[dict], text: str) -> dict:
    body = {"model": MODEL, "temperature": 0.2, "max_tokens": 1200,
            "chat_template_kwargs": {"enable_thinking": False},
            "messages": [{"role": "system", "content": SYSTEM}, *shots,
                         {"role": "user", "content": f"Brief:\n{text}"}]}
    last: Exception | None = None
    for attempt in range(4):
        try:
            r = client.post("/chat/completions", json=body)
            r.raise_for_status()
            content = r.json()["choices"][0]["message"]["content"] or ""
            content = re.sub(r"^```(?:json)?|```$", "", content.strip(), flags=re.M).strip()
            m = re.search(r"\{.*\}", content, re.S)
            answer = json.loads(m.group(0) if m else content)
            if not german(answer) and attempt < 3:
                last = ValueError("regest not in German")
                continue
            if gallen_unsupported(answer, text):
                if attempt < 3:
                    body["messages"] = body["messages"][:len(shots) + 2] + [
                        {"role": "assistant", "content": content},
                        {"role": "user", "content": "St. Gallen kommt in diesem Brief nicht als Absender oder Empfänger "
                                                    "vor (höchstens als Datum «sant Gallen tag»). Nimm Absender und "
                                                    "Empfänger nur aus diesem Brief und antworte noch einmal."}]
                    last = ValueError("St. Gallen not in the letter")
                    continue
                return drop_gallen(answer)
            return answer
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(5 * (attempt + 1))
    return {"error": str(last)[:300]}


def heading(d: dict) -> str:
    """"Schultheiss und Rat zu Bern an Schultheiss und Rat zu Thun, 1456" — the
    title line the St. Gallen viewer shows above an edited letter."""
    s, r = (d.get("sender") or "").strip(), (d.get("recipient") or "").strip()
    head = f"{s} an {r}" if s and r else (s or r)
    year = str(d.get("year") or "").strip()
    return f"{head}, {year}" if head and year.isdigit() else head


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=None, help="draft at most this many letters")
    ap.add_argument("--only", nargs="*", help="letter ids")
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()

    readings = {r: load_reader(r) for r in READERS}
    done: dict[str, dict] = {}
    if OUT.exists():
        for line in OUT.read_text(encoding="utf-8").splitlines():
            if line.strip():
                row = json.loads(line)
                done[row["id"]] = row
    jobs = []
    for lt in letters():
        if args.only and lt["id"] not in args.only:
            continue
        keys = lt["pages"].split(";")
        reader = next((r for r in READERS if all(readings[r].get(k, "").strip() for k in keys)), None)
        if reader is None:  # some page has no text in any reader: use what there is
            reader = next((r for r in READERS if any(readings[r].get(k, "").strip() for k in keys)), None)
        if reader is None:
            continue
        text = letter_text([readings[reader].get(k, "") for k in keys])
        old = done.get(lt["id"])
        if old and "error" not in old["draft"] and READERS.index(old["reader"]) <= READERS.index(reader) \
                and old.get("prompt") == PROMPT_DIGEST and not gallen_unsupported(old["draft"], text):
            continue
        jobs.append({"lt": lt, "reader": reader, "text": text})
    if args.n:
        jobs = jobs[: args.n]
    print(f"{len(jobs)} letters to draft via {MODEL} (prompt {PROMPT_DIGEST})", flush=True)
    if not jobs:
        return

    shots = examples()
    base = os.environ.get("GPUSTACK_BASE_URL", "https://gpustack.unibe.ch/v1")
    key = os.environ["GPUSTACK_API_KEY"]
    OUT.parent.mkdir(exist_ok=True)
    with httpx.Client(base_url=base, headers={"Authorization": f"Bearer {key}"}, timeout=300) as client, \
            ThreadPoolExecutor(args.workers) as pool, OUT.open("a", encoding="utf-8") as fh:
        for i, (j, a) in enumerate(zip(jobs, pool.map(lambda j: ask(client, shots, j["text"]), jobs)), 1):
            row = {"id": j["lt"]["id"], "title": j["lt"]["title"], "heading": heading(a),
                   "reader": j["reader"], "model": MODEL, "prompt": PROMPT_DIGEST,
                   "pages": j["lt"]["pages"].split(";"), "draft": a, "machine": True}
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
            fh.flush()
            if i % 25 == 0 or i == len(jobs):
                print(f"  {i}/{len(jobs)}", flush=True)


if __name__ == "__main__":
    main()
