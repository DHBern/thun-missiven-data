"""Ingest Transkribus collection 2329424 (BAT Thuner Missiven neu) onto the share.

out/originals/<doc title>/<doc title>_p0001.jpg   image as Transkribus serves it
out/pages/<doc title>_p0001.jpg                    1500 px working copy (reader input)
out/pagexml/<doc title>_p0001.xml                  latest transcript
out/manifest.jsonl                                 one line per page, with version history
Resumable: existing files are skipped.
"""
import io, json, sys, time
from pathlib import Path
sys.path.insert(0, "/home/dh/agentic_historian/agentic_historian")
from ruemlang import transkribus_pages as tp
from PIL import Image

COL = 2329424
OUT = Path(sys.argv[1])
for d in ("originals", "pages", "pagexml"):
    (OUT / d).mkdir(parents=True, exist_ok=True)
ts = tp.TkSession().authenticate()
docs = ts.get_json(f"{tp.API}/collections/{COL}/list", "list")
manifest = OUT / "manifest.jsonl"
seen = set()
if manifest.exists():
    seen = {json.loads(l)["key"] for l in manifest.open()}
mf = manifest.open("a")
n = 0
for doc in sorted(docs, key=lambda d: d["title"]):
    title = doc["title"].strip().replace(" ", "_")
    pages = tp.pages_of_document(ts, COL, int(doc["docId"]))
    hist = tp.transcript_history(ts, COL, int(doc["docId"]))
    for p in pages:
        key = f"{title}_p{p.page_nr:04d}"
        if key in seen:
            continue
        for attempt in range(5):
            try:
                orig = OUT / "originals" / title / f"{key}.jpg"
                orig.parent.mkdir(exist_ok=True)
                tp.download_image(ts, p, orig)
                work = OUT / "pages" / f"{key}.jpg"
                if not work.exists():
                    with Image.open(orig) as im:
                        im = im.convert("RGB")
                        im.thumbnail((1500, 1500))
                        im.save(work, quality=90)
                xml = tp.download_pagexml(ts, p)
                if xml:
                    (OUT / "pagexml" / f"{key}.xml").write_text(xml, encoding="utf-8")
                break
            except Exception as exc:
                print(f"{key}: {exc} (attempt {attempt+1})", flush=True)
                time.sleep(10 * (attempt + 1))
                if attempt >= 1:
                    ts = tp.TkSession().authenticate()
        else:
            print(f"{key}: GAVE UP", flush=True)
            continue
        row = {"key": key, "docId": p.docid, "doc": title, "pageNr": p.page_nr,
               "width": p.width, "height": p.height, "status": p.status,
               "lines": p.nr_lines, "transcribed_lines": p.nr_transcribed_lines,
               "versions": [{k: v[k] for k in ("tsId", "status", "toolName", "userName", "timestamp", "transcribed_lines")}
                            for v in hist.get(p.page_nr, [])]}
        mf.write(json.dumps(row, ensure_ascii=False) + "\n"); mf.flush()
        n += 1
        if n % 100 == 0:
            print(f"{n} pages", flush=True)
print(f"done: {n} new pages", flush=True)
