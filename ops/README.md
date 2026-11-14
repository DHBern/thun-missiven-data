# Operations: what runs where (installed 14.11.2026)

| Where | What | Unit / job | Status |
|---|---|---|---|
| tei | Transkribus ingest of collection 2329424 → share `tei/datasets/thun-missiven-images/` | `tei/thun_ingest.py` (nohup, once) | `~/thun-missiven-ingest/ingest.log` |
| tei | reading runs in order: Gemini test (200 pages, Argon + Flash) → sanity gate → Gemini full → from 19.11. 06:00, once no SG gateway run is active: VLM, kraken, TrOCR on the gateway | `tei/thun_runs.sh`, `thun-runs.timer` (hourly; a step blocked by the Gemini spending cap is retried every hour) | `~/thun-runs/status.log` |
| tei | collect, check, publish | `systemd/thun-pipeline.timer` (08:00, 20:00) | `~/thun-pipeline/status.jsonl` |
| UBELIX | olmOCR (fine-tuned) on the originals, 3 shards | `ubelix/recognize_thun.sbatch`, job 22228399, `--begin 2026-11-19T06:00` | output `tei/thun-readings/ubelix/<model>/` on the share |
| asteraix | NER (hmBERT, St. Gallen edition tagging, GPU 1) + tagging + linking to the St. Gallen registers, once the Argon reading is ≥ 95 % complete | `asteraix/thun_ner.sh`, `thun-ner.timer` (every 3 h from 19.11.) | `~/thun-ner/status.log`; opens a PR here |

Computationally heavy steps start only after the St. Gallen runs (planned end Wed 18.11.2026).
The Gemini runs are API calls and start as soon as the prompt is on tei and the spending cap allows.
