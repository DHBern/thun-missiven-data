# Plan: tagging (NER) and a register of persons and places

Status, 17.11.2026 evening:
- **Done:** N-2a, the hmBERT baseline, run locally instead of on asteraix (`entities/hmbert/`);
  R-1, R-2 and R-4 (register, map, Sankey; `docs/REGISTER.md`).
- **Running since 17.11.:** N-2c on all 4,980 pages with an Argon text, on tei
  (`scripts/ner_llm.py`, see "Tagging, as started" below).
- **Waiting for a person:** N-1, the gold sample, and R-0, the check sample.

The St. Gallen Missiven have both already: tagging after the edition's model
(DHBern/sg-missiven-data `docs/NER.md`) and a register with generated entries and
graded authority links (`docs/REGISTER.md`). The Thun plan follows them. It has one
difference that shapes every step: **Thun has no edition and no register.** In
St. Gallen the editors' tagging is what the taggers learn from and are measured
against, and the editors' register is what the links are measured against. Thun has
neither, so a small hand-made sample has to stand in for both (N-1, R-0).

## What there is to work with

- Readings of all 5,165 pages: Gemini 4 Argon, Gemini 3.8 Flash, the Transkribus
  reading (PyLaia), with the Gemini prompt in St. Gallen's conventions, so a tagger
  trained there reads the same forms.
- 2,549 letters, split by scan name; regest drafts with sender, recipient and date
  line for 2,542; dates by rule (`dates/dates.jsonl`).
- From St. Gallen: the ten-label tag set, the trained hmBERT model, the combined
  tagger (hmBERT and qwen3.8 propose, gpt-oss-120b decides), the register code with
  its grading rules, the authority sources (HLS, Wikidata, Human Lineage, SSRQ persons
  and places) and their measured precision.

## Tagging (NER)

**N-0. Tag set.** St. Gallen's ten labels, unchanged: `persName`, `persName@issuer`,
`persName@recipient`, `orgName` (+ the two roles), `placeName`, `origPlace`, `origDate`,
`date`. In Thun the roles are mostly fixed (issuer: Schultheiss und Rat zu Bern;
recipient: Schultheiss und Rat zu Thun), which makes them easy, and the regest drafts
already name them per letter.

**N-1. A Thun gold sample (needs a person).** 50 letters (about 100 pages), drawn by
decade so that 1400–1540 is covered, tagged by hand on the Argon reading. To make it
fast, the person corrects a draft from the combined tagger instead of starting empty:
about 5–6 hours. Format: the same JSONL as `entities/`, plus the reviewer and date.
Without this sample nothing in the following steps can be measured on Thun; with it,
every number below is a Thun number, not a St. Gallen one.

**N-2. Taggers.**
- a) *Baseline (scheduled):* hmBERT trained on the St. Gallen edition, on asteraix,
  from 19.11. Tags all Thun pages; its links go to the St. Gallen registers only.
- b) *qwen3.8-27b tagger* (St. Gallen's `ner_llm.py`) with few-shot examples from the
  Thun gold sample (cross-validated by letter, so no test letter is shown).
- c) *Judge* (gpt-oss-120b) over the proposals of a) and b), as in St. Gallen, where it
  gave the best result. For Thun it gets the letter's regest and date as context.
- d) Once the gold sample exists: fine-tune hmBERT on St. Gallen + Thun gold
  (asteraix, about an hour) and compare with a).

**Tagging, as started (17.11.2026).** St. Gallen's best combination, without waiting for
the Thun gold sample:
- *Proposals:* hmBERT's tags (from the St. Gallen edition) and qwen3.8-27b's tags. The qwen3.8
  examples are six pages of three St. Gallen letters from Bern
  (`prompts/ner_examples_sg.json`, the same letters as the regest examples), with the
  edition's tags projected onto the Argon reading.
- *Decision:* gpt-oss-120b keeps or drops each proposal and sets its label and role. In
  St. Gallen it also chose the register entry; here it does not, because Thun has no
  register. Links come from the generated register (`scripts/register.py`), rebuilt from
  these tags.
- *Text:* the Argon reading, not the joint reading. On 60 edited St. Gallen pages the qwen3.8
  joint reading was no better than Argon (see "The joint reading" below). St. Gallen's rule
  holds: re-tag only on a reading that is at least one point of CER better.
- *Expected quality:* St. Gallen's numbers for this method, F1 0.71 overall (persons 0.71,
  organisations 0.78, places 0.75), are measured there, not here. Thun's letters are
  similar but not the same. Only N-1 gives a Thun figure.
- *Run:* tei, unit `thun-ner-llm`, output `~/thun-ner-state/combined.jsonl`, log
  `run.log`. Two calls per page, four at a time. When it is complete it replaces
  `entities/gemini-4-argon.jsonl` (`"method": "combined"`, `by` per tag), and the register
  and the site are rebuilt from it.

**The joint reading (17.11.2026).** `scripts/joint_reading.py`: qwen3.8-27b sees the page
image and the readings of Argon, Flash and PyLaia, and writes the page once. Thun has no
edition to measure it on, so the method was run on 60 random edited St. Gallen pages, with
a kraken line reader in place of PyLaia. CER against the edition:

| | CER |
|---|---:|
| Argon | 10.52 % |
| Flash | 19.00 % |
| kraken (Bern) | 35.48 % |
| Joint, prompt v1 ("A is usually the best") | 10.50 % |
| Joint, prompt v2 (no reader preferred, the image decides) | 10.70 % |

- With v1 the model copies Argon: 17 of 60 pages changed, by 0.1 % of the text on average.
- With v2 it changes more (44 pages, 0.6 %), but more often for the worse: better than
  Argon on 14 pages, worse on 23.
- So qwen3.8 does not improve on Argon, as St. Gallen found for the vote and for the
  revision of uncertain words. Not run over the Thun pages so far; tagging stays on Argon.

**N-3. Measure and decide.** On the gold sample, by letter (5-fold): F1 per label,
with and without roles. Gate as in St. Gallen: persons, organisations and places at
F1 ≥ 0.70. The best combination tags all pages (N-4); the others are kept for
comparison.

**N-4. Run.** All 5,165 pages: hmBERT on asteraix (minutes), qwen3.8 and the judge on
GPUStack (about 10,000 calls, roughly a day at four workers). Then the tags go into
`entities/`, the viewer shows them (the hook exists), and the pipeline tags new
readings incrementally, as in St. Gallen.

## Register

**R-0. A check sample (needs a person).** 100 register entries (60 persons,
40 places), checked by hand against HLS and the Berner Ortsnamenbuch: is the proposed
identification right? About 4 hours. This is what the grades are measured on, the way
St. Gallen measured them on its edition's own entries.

**R-1. Entries from the tags.** Group the tagged names into entries:
- **Places:** normalised spelling (u/v, i/y, doubled letters, -ingen/-ingen variants), then
  fuzzy grouping. A place is one entry per settlement.
- **Organisations:** mostly corporate bodies (Schultheiss und Rat zu Bern, die von
  Thun, Landleute von Frutigen …); normalised to the St. Gallen register's forms where
  the body is the same.
- **Persons:** name + time. Two mentions are the same person only if the spellings
  agree (≥ 90) **and** the letters lie within 30 years of each other, or an office ties
  them (Schultheiss zu Thun, Venner, Spitalvogt). Persons are where St. Gallen found
  linking hardest (known spellings right in 77 %), so here a person entry is a
  proposal, never merged across a doubt.
- Each entry keeps every spelling with its letters and pages, the roles, and the years.

**R-2. Matching against four registers (decided 17.11.2026: HLS, SSRQ, KF, St. Gallen),
graded.** As in St. Gallen (sicher / wahrscheinlich / möglich, by rules, with the
precision measured on R-0 shown beside every grade). Every entry is looked up in all
four; agreeing candidates (same HLS id) are folded into one:
- **HLS** (our `hls` MCP: persons `per…`, places `loc…`, articles): the Bernese and
  Thun families and office holders, every settlement with an article. The HLS id is
  the hub the others join on.
- **SSRQ** (our `ssrq` MCP for persons and organisations, with the years they are
  attested; the SSRQ place database `loci.ssrq-sds-fds.ch` for places, with historical
  spellings and links to HLS and GND). Candidates at most "wahrscheinlich", as in
  St. Gallen.
- **KF**, Königsfelden (our `kf` MCP: persons and places with HLS ids, 1300–1658):
  Habsburg and Aargau persons and places, overlapping with Bern in the 14th–15th c.
- **St. Gallen** (DHBern/sg-missiven-data `person/`, `place/`, and its generated
  entries): shared corporate actors (Schultheiss und Rat zu Bern, eidgenössische
  Orte), Bernese persons who wrote to both towns, places with coordinates. A match
  gets a link to the St. Gallen register entry and back (`links/`).
- Coordinates for the map come from the matched entry (SG register, SSRQ, Wikidata via
  the HLS id), never from a name alone.
- A name alone never makes a "sicher" link; St. Gallen's lessons hold (places never
  "sicher"; SSRQ candidates at most "wahrscheinlich"; persons only within the years).

**R-3. Office holders.** The Schultheissen of Thun (and Bern's Schultheissen and
Stadtschreiber) appear in nearly every address and signature. A list of them by year,
from the letters and checked against HLS, both helps person linking (R-1) and dates
letters whose year is uncertain.

**R-4. Viewer.** Register pages for persons, places and organisations (all spellings,
letters, years, graded links, "automatisch" marking), names in the text linked to their
entries, register facets in the search — as on the St. Gallen site. On the overview
(decided 17.11.2026):
- a **geographic access**: a map of the places with coordinates (Leaflet, as St. Gallen),
  each place opening its letters;
- a **Sankey** as St. Gallen's: a keyword → its most frequent companions → their periods.
  It needs the keywords (St. Gallen's vocabulary, `scripts/keywords.py`) and the dates
  (`dates/dates.jsonl`, done).

**R-5. Both collections.** Entries that are also in the St. Gallen register (Bern's
council, Bernese persons, shared places) get a link to it; the St. Gallen site gets the
reverse link (`links/`).

## Order and effort

| Step | Who / where | Effort |
|---|---|---|
| N-2a baseline | asteraix, scheduled 19.11. | runs alone |
| N-1 gold sample | a person (draft from the tagger) | 5–6 h |
| N-2b–d, N-3 | GPUStack, asteraix | 1–2 days of runs |
| N-4 all pages | GPUStack, asteraix | about 1 day |
| R-1, R-2, R-3 | scripts from St. Gallen, adapted | 2–3 days of work |
| R-0 check sample | a person | about 4 h |
| R-4, R-5 viewer | — | 1 day |

Heavy runs (asteraix, UBELIX, idhefix) wait for the St. Gallen runs to end;
GPUStack runs only with the UniBE network.

## Open decisions

1. **Who makes the gold sample (N-1) and the check sample (R-0)**, and how large.
   Without them the tagging and the register can be produced, but not measured on Thun.
2. **Combined tagger or hmBERT alone.** Recommended: combined, as in St. Gallen.
3. **Register scope:** persons, places and organisations, or persons and places only
   (as asked); organisations come almost free from the tags.
4. **Keep the baseline job of 19.11.?** Recommended: yes, as the reference point.
