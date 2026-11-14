# Continuous collection and publication on tei

Readings of the Thun Missiven arrive from several machines over days. tei
collects them as they come, checks the result and publishes it, without a
laptop in the loop. The pipeline is a fork of the St. Gallen one
(DHBern/sg-missiven-data, `docs/PIPELINE.md`), cut down: there is no edition,
so no joint reading, no tagging and no regests yet. Written 14.11.2026.

## Who does what

| Machine | Role |
|---|---|
| **tei** | orchestrator: imports the Transkribus ingest, collects, builds, publishes; checkout `~/thun-missiven-data` |
| Transkribus | the PyLaia reading (collection 2329424); ingested to the share by `~/thun-missiven-ingest/thun_ingest.py` on tei |
| Gemini API | Argon and Flash, started from tei (`atr-batch --via external`) |
| idhefix (ATR gateway) | Qwen3.5-4B fine-tuned, kraken, TrOCR, started from tei (`atr-batch`) |
| UBELIX | larger runs; output to the research share, which tei mounts |

Everything the pipeline reads is on tei's disk or on the research share
(`/mnt/wbkolleg_dh_1`). UBELIX jobs write to
`tei/thun-readings/ubelix/<model>/*.jsonl` there, so collecting them needs no
login to UBELIX. The page images stay on the share
(`tei/datasets/thun-missiven-images/`): they are not public and never enter the
repository.

## Sources (`readings/sources.json`)

1. **Transkribus:** `manifest.jsonl` and `pagexml/` of the ingest.
   `scripts/import_transkribus.py` writes `readings/pages.tsv` (the list of
   pages: the viewer knows no page that is not in it) and
   `readings/transkribus-pylaia-m2.4.jsonl`. It drops every user name and
   e-mail address of the manifest, and refuses to write if either output would
   have fewer pages than now.
2. **Gateway and Gemini runs** under
   `~/agentic_historian/agentic_historian/data/vlm_test/`:
   `thun-missiven-gemini-v1/{gemini-4-argon,gemini-3.8-flash}`,
   `thun-missiven-vlm-v1/qwen3.5-4b-german-kurrent-xvi-xix-page-v1`,
   `thun-missiven-kraken-v1/{kraken-bern-combined-v1,kraken-cursive_inzigkofen}`,
   `thun-missiven-trocr-v1/{trocr-medieval-escriptmask,trocr-kurrent-xvi-xvii}`.
3. **UBELIX:** `/mnt/wbkolleg_dh_1/tei/thun-readings/ubelix/<model>/*.jsonl`,
   the reader named after the folder.

A source that does not exist yet is skipped. Each model's reading is merged
into `readings/<model>.jsonl` (`scripts/collect_series.py`): pages are added or
updated, never removed; a failed record (rate limit, error) is not taken. A
reader shows in the viewer only once it is described in `readings/readers.json`;
that entry is code-reviewed by a person, not written by the pipeline.

## One cycle

`scripts/pipeline.sh`, run by a systemd **user** timer on tei (dh has linger) at
**08:00 and 20:00**, half an hour after St. Gallen's (07:30, 19:30), and on
demand (`systemctl --user start thun-pipeline`). Units in `ops/systemd/`; status
in `~/thun-pipeline/status.jsonl`.

1. **Reset** the checkout to `origin/main`.
2. **Import** the Transkribus ingest (`import_transkribus.py`, needs lxml).
3. **Collect** the other sources (`collect_series.py`, standard library).
4. **Check:**
   - no reader's page count and not the page list may drop;
   - only `readings/` and `entities/` may change;
   - `build_site.py` must run without error.
5. **Publish:** one rolling branch `data/auto`, one PR "Readings update
   (automatic, tei)", merged by the script once the checks pass (St. Gallen's
   decision B of 13.11.2026). Pages deploys from `main`.
6. **Report:** a line in `~/thun-pipeline/status.jsonl`.

A cycle that finds nothing new commits nothing.

**No joint reading.** St. Gallen's `joint_reading.py` weighs each voter by its
error rate against the edition. The Thun Missiven have no edition and no ground
truth to weigh voters against, so the step is left out and the script is not
in this repository. It can come back once there is something to measure
against (for example a few dozen pages corrected by hand).

## Deploying (by hand, once)

The repository writes the files; installing them on tei is a separate step,
done by a person:

```bash
# on tei, as dh
git clone https://github.com/DHBern/thun-missiven-data.git ~/thun-missiven-data
mkdir -p ~/.config/systemd/user
cp ~/thun-missiven-data/ops/systemd/thun-pipeline.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
~/thun-missiven-data/scripts/pipeline.sh --dry-run      # collect and check, publish nothing
systemctl --user enable --now thun-pipeline.timer
```

`pipeline.sh` uses St. Gallen's venv (`~/sg-missiven-venv`, lxml and rapidfuzz)
unless `THM_PY` names another; `THM_REPO` and `THM_STATE` move the checkout and
the state directory. `gh` must be logged in with push rights to
DHBern/thun-missiven-data.

## Limits on tei

- Disk: `/` is tight. The checkout holds text only; `site/data` is rebuilt in
  place and ignored by git.
- Git growth: each collection rewrites whole jsonl files; hence two cycles a
  day.
