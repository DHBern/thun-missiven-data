# Adding a reading

The viewer shows every reader listed in `readings/readers.json` that has a file
`readings/<id>.jsonl`. A reading is keyed by the **page key**,
`<Transkribus document title>_p<4-digit page number>`, e.g.
`BAT_663.1_350_399_p0005`; `readings/pages.tsv` lists every key. Once a change
is merged into `main`, the Pages workflow rebuilds the site.

There is no edition and no ground truth for these letters, so a new reading is
**not scored**. Where a page has two or more readings, the build reports how
much they disagree (edits ÷ the longer text). That is disagreement, never
quality.

## Images

The page images are on the research share
(`/mnt/wbkolleg_dh_1/tei/datasets/thun-missiven-images/pages/<key>.jpg`, 1500 px
working copies). They are **not public**: the rights of the Burgerarchiv Thun
are not cleared. Run engines on them where they lie; never copy them into this
repository or anywhere public.

## One command per source

| Source | Command |
|---|---|
| A gateway or Gemini run on tei (`vlm_test/<run>/<model>/<key>.json`) | `python3 scripts/collect_readings.py <run dir>` (or one model folder of it) |
| A UBELIX job (`thun-readings/ubelix/<model>/shard-*.jsonl`) | `python3 scripts/collect_readings.py '<dir>/*.jsonl' --reader <model>` |
| Everything in `readings/sources.json` (what the pipeline does) | `python3 scripts/collect_series.py` |
| PAGE XML, ALTO or plain text, one file per page | `uv run --with lxml python scripts/import_readings.py <id> <folder>` |
| The Transkribus collection itself | `uv run --with lxml python scripts/import_transkribus.py <manifest.jsonl> <pagexml dir>` |

`collect_*` merge: pages are added or updated, never removed, and a failed
record (rate limit, error) leaves the page unread rather than empty. They need
only the standard library. `import_readings.py` matches a file to a page by the
stem of its name, case-insensitive, image extension ignored
(`BAT_663.1_350_399_p0005.jpg.txt` belongs to `BAT_663.1_350_399_p0005`).

For a vision-language model, use the prompt in
`prompts/thun_missiven_page_v1.md`, so the readings differ by model and not by
instruction. Read the end of a few pages before a full run: a page that hits the
token limit comes back as an ordinary answer that stops mid-sentence, and should
be marked `"truncated": true`.

## Describe the reader

Add an entry to `readings/readers.json`; its order is the order of the buttons.

```json
{"id": "gemini-4-argon",
 "label": "Gemini 4 Argon", "kind": "commercial VLM",
 "about": "Google's frontier model, zero-shot, whole page, prompt thun_missiven_page_v1.",
 "caveat": "Optional: anything a reader must know.",
 "label_de": "Gemini 4 Argon", "kind_de": "kommerzielles VLM",
 "about_de": "…", "caveat_de": "…"}
```

`id`, `label` and `kind` are required; give the German fields too, the viewer
is bilingual. A reader trained on these pages, or a reader whose output is
normalised, needs a `caveat`.

## Check locally

```bash
uv run -p 3.12 --with rapidfuzz==3.10.1 python scripts/build_site.py
python3 -m http.server -d site 8000      # http://localhost:8000
```

`build_site.py` prints every reader's page count and the disagreement of every
pair. Look at a few pages with **Compare with …** before you trust a new reader.

## Entities (planned)

When a tagging exists, write it as `entities/<reader>.jsonl`, one page per line,
in the St. Gallen format: `{"key": ..., "entities": [{"start", "end", "type"
(per|org|place|date), "text", "ref"?}]}`, offsets into that reader's text after
empty lines are dropped. The build attaches it to the page and the viewer offers
an **Entities** view for that reader.
