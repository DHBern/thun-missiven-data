import sys, json
sys.path.insert(0, ".")
from ruemlang import transkribus_pages as tp
ts = tp.TkSession().authenticate()
docs = ts.get_json(f"{tp.API}/collections/2329424/list", "x")
with open("/home/dh/thun-missiven-ingest/images.jsonl", "w") as fh:
    for d in docs:
        c = ts.get_json(f"{tp.API}/collections/2329424/{d['docId']}/fulldoc", "x")
        title = c["md"]["title"].strip().replace(" ", "_")
        for p in c["pageList"]["pages"]:
            fh.write(json.dumps({"key": f"{title}_p{p['pageNr']:04d}", "doc": title, "docId": d["docId"],
                                 "pageNr": p["pageNr"], "img": p.get("imgFileName"), "tk": p.get("key"),
                                 "w": p.get("width"), "h": p.get("height")}) + "\n")
print("ok")
