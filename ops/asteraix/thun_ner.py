"""Tag and link the Thun Missiven with the St. Gallen NER model (hmBERT, scripts/ner.py of
DHBern/sg-missiven-data), trained on the St. Gallen edition's tagging projected onto the
same reader. Thun has no tagging of its own, so nothing here is measured on Thun.

    python thun_ner.py <sg checkout> <thun checkout> [reader]

Linking (NEL) uses the St. Gallen registers and only the link kinds the St. Gallen
cross-validation measured at precision >= 0.9 (report["policy"]["allowed"]). On top:
  * a person is linked only when the page itself gives a year (dates.year_from_text) —
    the +-40-year window needs one, and Thun pages have no neighbours with known dates;
  * every Thun link is cert="medium" and says register="stadtasg": precision was
    measured on St. Gallen, not here.
Writes <thun>/entities/<reader>.jsonl and <thun>/entities/unlinked_<reader>.tsv.
"""
import json
import sys
from pathlib import Path

SG, THUN = Path(sys.argv[1]), Path(sys.argv[2])
READER = sys.argv[3] if len(sys.argv) > 3 else "gemini-4-argon"
sys.path.insert(0, str(SG / "scripts"))
import ner  # noqa: E402
from dates import year_from_text  # noqa: E402
import torch  # noqa: E402
from transformers import AutoModelForTokenClassification, AutoTokenizer  # noqa: E402

dev = "cuda" if torch.cuda.is_available() else "cpu"
model_dir = SG / "models" / f"ner-{READER}"
report = json.loads((SG / "entities" / f"{READER}.report.json").read_text(encoding="utf-8"))
allowed = set(report["policy"]["allowed"])
edited, _ = ner.build_pages(READER, None, unedited=False)
linker = ner.Linker(edited, ner.register_names())

pages = []
for line in (THUN / "readings" / f"{READER}.jsonl").read_text(encoding="utf-8").splitlines():
    if not line.strip():
        continue
    r = json.loads(line)
    text = "\n".join(l for l in (r.get("text") or "").splitlines() if l.strip())
    if not text:
        continue
    year, _how = year_from_text(text, None)
    words, offs, labels = ner.words_and_labels(text, [], [])
    pages.append({"letter": r.get("doc") or r["key"].rsplit("_p", 1)[0], "facs": r["key"], "text": text,
                  "edition_text": "", "gold": [], "projected": [], "words": words, "offs": offs,
                  "labels": labels, "has_edition": False, "unedited": True, "year": year,
                  "nr": None, "expected": None})
print(f"{len(pages)} Thun pages read by {READER}; {sum(1 for p in pages if p['year'])} with a year", flush=True)

tok = AutoTokenizer.from_pretrained(model_dir)
model = AutoModelForTokenClassification.from_pretrained(model_dir).to(dev).eval()
ner.predict(tok, model, pages, dev)
ner.apply_links(pages, linker, allowed)

out_dir = THUN / "entities"
out_dir.mkdir(exist_ok=True)
n_ent = n_link = 0
with (out_dir / f"{READER}.jsonl").open("w", encoding="utf-8") as fh:
    for p in sorted(pages, key=lambda p: p["facs"]):
        ents = []
        for x in p["pred"]:
            if x.get("ref") and ner.coarse(x["type"]) == "per" and not p.get("year"):
                x["ref"] = None
            e = ner.entity_out(x)
            if e.get("ref"):
                e["cert"] = "medium"
                e["register"] = "stadtasg"
                n_link += 1
            ents.append(e)
        n_ent += len(ents)
        fh.write(json.dumps({"key": p["facs"], "auto": True, "unedited": True, "year": p.get("year"),
                             "entities": ents}, ensure_ascii=False) + "\n")
n_un = ner.write_unlinked(pages, out_dir / f"unlinked_{READER}.tsv")
meta = {"reader": READER, "model": "hmBERT trained on the St. Gallen edition (sg-missiven-data scripts/ner.py)",
        "sg_report": {"late_letters": report.get("late_letters", {}).get("edition", {}).get("all"),
                      "allowed_links": sorted(allowed)},
        "pages": len(pages), "entities": n_ent, "linked": n_link, "unlinked_groups": n_un,
        "caveat": "not measured on Thun; links to the St. Gallen registers, cert=medium"}
(out_dir / f"{READER}.report.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False), encoding="utf-8")
print(json.dumps(meta, ensure_ascii=False), flush=True)
