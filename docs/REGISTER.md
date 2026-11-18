# Register: persons, places and organisations (generated automatically)

Status 18.11.2026 (rebuilt from the combined tagging). Plan steps R-1, R-2, R-4 and R-5 of
[NER_REGISTER_PLAN.md](NER_REGISTER_PLAN.md); R-0 (a check sample made by a
person) is **not done**; R-3 (office holders by year) is built but not used yet ([OFFICES.md](OFFICES.md)).

The Thun Missives have no edition and no register. Everything here is
**generated automatically** from the tagging in `entities/gemini-4-argon.jsonl`.
That tagging is St. Gallen's combined method on the Gemini 4 Argon reading
(`scripts/ner_llm.py`: hmBERT and qwen3.8-27b propose, gpt-oss-120b decides; until
17.11.2026 hmBERT alone, kept in `entities/hmbert/`), and it has **not been measured
on Thun**. All counts and the spot check below are from the register of 18.11.
Every link is a proposal,
graded by the rules St. Gallen wrote and measured for its own generated entries
(DHBern/sg-missiven-data `docs/REGISTER.md`, `scripts/auto_register.py`,
`scripts/ssrq_match.py`). No person has checked any of it.

## Outputs

| File | Content |
|---|---|
| `registers/places.json` | 1,210 places (215 on the map) |
| `registers/persons.json` | 4,123 persons |
| `registers/orgs.json` | 205 organisations |
| `links/registers/st-gallen.json` | 211 links from Thun entries to entries of the St. Gallen register (Thun side only) |
| `docs/places_without_coordinates.md` | the places not on the map, and why |

Each entry carries:

- every spelling, with how often it occurs;
- its letters and pages, and the years of those letters (`dates/dates.jsonl`);
- its roles (issuer, recipient, place of writing);
- the St. Gallen register ids that the tagger already attached (`sg_tag_refs`);
- up to four graded candidates, each with its sources, ids and links;
- for places, coordinates and where they come from;
- `occ`: each mention as `[page, start, end]`. Through this the viewer links the
  names in a letter to their entries.

Run `scripts/register.py link` to build the files, then `register.py docs`
(docs/PIPELINE.md says when and where). It is resumable: every answer is cached
in `registers/.cache/`, which is not committed.

## R-1: entries from the tags

15,380 tagged names of type person, organisation or place (18.11.; 18,564 with hmBERT alone).

- **Places.** Names are folded as in St. Gallen (u/v/w, i/y, doubled letters,
  ph/f, th/t, tz/z, ck/k, ä/e …). A trailing inflection joins its stem (Berne →
  Bern, Thuno → Thun). Spellings whose best candidate names the same settlement
  at grade «wahrscheinlich» (same HLS or SSRQ id) become one entry. A spelling
  graded only «möglich» stays its own entry: «Ober- hofen» is not joined to
  Oberhofen. Dropped: 14 mentions of forenames tagged as places.
- **Organisations.** The address formula is normalised to the form the St. Gallen
  register uses. "Schulths und rat ze Berne", "Schultheis und der Rat der Statt
  Bern" and "Schulths und rat ze Brn" all become «Schultheiss und Rat zu Bern».
  The place inside the formula is read through the place entries, with the
  scribes' abbreviations of Bern. "Rat zu X", "die von X" and "zuo Thun" fold
  into «Schultheiss und Rat zu X» where that body is named. Other names are
  grouped by spelling (≥ 90). Dropped: 9 mentions of a title or office alone
  ("Schulthes"), 28 formulas without a place.
- **Persons.** Forenames are stemmed (Petern → Peter, Hansen → Hans). Two
  spellings are one name if the whole name agrees (≥ 90) **and** the surname
  alone agrees (≥ 85). Each spelling is compared with the name's most frequent
  spelling, not chained, so that a shared forename does not carry two surnames
  together (Schopfer and Scherer). A name is one person only within 30 years of
  its first letter; later letters make a new entry. A mention without a year
  joins a name only if that name has a single entry. Offices are **not** used to
  merge (R-3 not done). Dropped:

  | Reason | Mentions |
  |---|---:|
  | bare forenames, also spelled otherwise (Peter, Hensli, Burckart) | 980 |
  | names that are a place's (Thun, Inderlapen, Kander) | 89 |
  | titles or offices alone (Schulthes, alt, bapst) | 22 |
  | fragments | 3 |

  Far fewer than with hmBERT alone (1,280 / 302 / 326, and 55 particles, 30
  fragments): gpt-oss already drops most titles, place names and particles
  tagged as persons.

## R-2: matching against four authorities

Every entry is looked up in all four sources. Candidates that share an HLS or
SSRQ id are folded into one, with the better grade. Königsfelden and the SSRQ
share their ids.

- **HLS**, through our MCP: the persons list (24,169, with life dates) and the
  geographical articles.
  - The server's geographical list is incomplete. On 17.11.2026 it lacked the
    municipalities Bern, Thun, Spiez, Hilterfingen, Oberhofen am Thunersee and
    1,654 more.
  - The missing HLS articles are taken from Wikidata by their HLS id (P902), with
    Wikidata's label and coordinates. Two queries to the Query Service in all;
    the search API refused St. Gallen with 429.
- **SSRQ**
  - Persons through our MCP, with the years they are attested.
  - Organisations through the MCP: the formula's town and type, otherwise the
    name index.
  - Places through loci.ssrq-sds-fds.ch, its fuzzy search and recorded spellings.
    A search takes 5–15 s there, so it is asked only for spellings tagged at least
    twice: 412 of 1,393.
- **Königsfelden** (KF, our MCP): places with coordinates and HLS ids, persons
  with the years of the documents that name them, organisations.
- **St. Gallen**: the edition's register (`person/person.xml`, `place/place.xml`,
  1,790 entries) and, for cross-links only, its generated entries
  (`registers/auto_register.json`).

### Grades

| | sicher | wahrscheinlich | möglich |
|---|---|---|---|
| Persons, HLS (rule *name*) | forename and surname ≥ 95, the letters in the adult life, no rival within 5 | ≥ 90, years fit, no rival | ≥ 82, years fit |
| Persons, SSRQ / Königsfelden / St. Gallen (rule *ssrq*) | never | ≥ 95, attested within 40 years of the letters, no rival within 3 | ≥ 82, attested within 40 years |
| Places, HLS / St. Gallen / Königsfelden (rule *name*) | never | the spelling is a name of a place with an HLS article; settlements, then the nearest to Thun, first | another exact name, or a close spelling (≥ 85) |
| Places, SSRQ (rule *ssrq*) | never | the spelling is the name or a recorded spelling of exactly one settlement | a close spelling (≥ 85) |
| Organisations | never | the normalised formula is the main name of a St. Gallen register entry | an SSRQ or Königsfelden body of that town and type, or an SSRQ name ≥ 85 |

Measured precision, borrowed from St. Gallen (on the edition's own entries; not a
Thun measurement):

| Rule | sicher | wahrscheinlich | möglich |
|---|---|---|---|
| Persons, *name* | 35/37 = 95 % | 6/9 = 67 % | 6/10 = 60 % |
| Persons, *ssrq* | – | 97/99 = 98 % | 62/99 = 63 % |
| Places, *name* | – | 61/82 = 74 % | 19/77 = 25 % |
| Places, *ssrq* | – | 52/56 = 93 % | 44/73 = 60 % |

Not measured anywhere: persons matched to the St. Gallen register, and every
organisation rule. The viewer says so beside those grades.

### What Thun adds to St. Gallen's rules

Each of these is marked in the code:

- Place candidates are ordered by distance to **Thun**, not St. Gallen, and
  settlements come first. Without this, "Oberhofen" went to Oberhofen AG,
  96 km away, at grade «wahrscheinlich».
- A close place spelling also counts with t/d, p/b and k/g as one letter
  (Inderlappen ~ Interlaken, Undersewen ~ Unterseen). This gives «möglich» only.
- A person with a single name (a surname alone) is never more than «möglich».
- St. Gallen register entries named "NN, Konrad" (a forename without a person)
  are not proposed.
- The organisation rule «wahrscheinlich» (the formula is a St. Gallen main name)
  is new and not measured.

### The run of 18.11.2026 (combined tagging)

| | sicher | wahrscheinlich | möglich | no candidate |
|---|---:|---:|---:|---:|
| Places (1,210) | – | 219 | 334 | 657 |
| Persons (4,123) | 15 | 52 | 140 | 3,916 |
| Organisations (205) | – | 10 | 21 | 174 |

For comparison, the run of 17.11.2026 on hmBERT's tags alone: places 1,376 (220 /
364), persons 4,631 (14 / 47 / 156), organisations 276 (10 / 42).

Best candidate by source:

- **Places:**
  - HLS: 181 wahrscheinlich, 279 möglich;
  - SSRQ: 78 / 72;
  - St. Gallen: 35 / 5;
  - Königsfelden: 16 / 6.
- **Persons:**
  - HLS: 15 sicher, 4 wahrscheinlich, 7 möglich;
  - SSRQ: 36 wahrscheinlich, 76 möglich;
  - Königsfelden: 18 / 16;
  - St. Gallen: 1 sicher, 11 wahrscheinlich, 58 möglich.
- **Organisations:**
  - St. Gallen: 10 wahrscheinlich, 9 möglich;
  - SSRQ: 5 / 13;
  - Königsfelden: 3 / 6.

A candidate found in several sources counts for each of them.

Most entries have no candidate. Most are spellings tagged once (597 of the
657 places without one), and most persons in these letters are burghers of Thun and the
Oberland, who are in no authority file.

**The largest entries:**

| Entry | Letters | Best candidate |
|---|---:|---|
| «Schultheiss und Rat zu Thun» | 1,817 | none: the SSRQ and St. Gallen have no such body; St. Gallen has «Bürgermeister und Rat zu Thun», proposed as «möglich» |
| «Schultheiss und Rat zu Bern» | 1,724 | wahrscheinlich: St. Gallen, SSRQ and Königsfelden agree on org004002 |
| Thun | 760 | HLS 000541, wahrscheinlich |
| Bern | 219 | wahrscheinlich |
| Peter Schopfer, Schultheiss of Thun | 182 (1441–1471) and 59 (1410–1440) | möglich: SSRQ and Königsfelden, attested 1439 |
| Basel | 54 | wahrscheinlich |
| Oberhofen | 52 | Oberhofen am Thunersee, wahrscheinlich |

Peter Schopfer, to whom Bern writes as Schultheiss of Thun in many letters, is the
most frequent person (248 tagged mentions; 276 with hmBERT alone). He is split
in two entries because a name is one person only within 30 years of its first
letter, and offices are not used to join persons (R-3, issue #12).

## Coordinates and the map

Coordinates come **only** from a matched candidate, never from a name alone:

- the St. Gallen register (34 places);
- an HLS article on our server (91);
- Wikidata, by the candidate's HLS id (90).

So 215 places have coordinates from a candidate graded «wahrscheinlich». The
overview map shows these. 304 more have coordinates only from a «möglich»
candidate; the map shows them on request, dashed. Letters that name a place on
the map: 1,371.

995 places are not on the map (18.11.; 1,163 on 17.11.). They are listed in
[places_without_coordinates.md](places_without_coordinates.md) with the reason
for each.

## R-5: St. Gallen

`links/registers/st-gallen.json` lists 211 links:

- **Places, 95:**
  - 56 to entries of the St. Gallen register, 35 of them «wahrscheinlich»;
  - 39 to St. Gallen generated entries whose best candidate is the same HLS
    article.
  74 of the 95 are «wahrscheinlich».
- **Organisations, 20:** «Schultheiss und Rat zu Bern», Solothurn, Luzern …;
  10 of them «wahrscheinlich».
- **Persons, 96:** 1 «sicher», 11 «wahrscheinlich», 84 only «möglich». The spot
  check below finds the «möglich» ones from the St. Gallen register wrong.

The viewer shows the link on the Thun entry page (to `#/entry/<id>` on the
St. Gallen site). No change was made to sg-missiven-data.

Candidates for a reverse link from St. Gallen, if wanted, are the entries
graded «wahrscheinlich» or better:

- «Schultheiss und Rat zu Bern» = `stadtasg-actors-514`;
- the bodies of Solothurn, Luzern, Zürich, St. Gallen, Basel and Schaffhausen;
- 74 places, among them Zürich, Freiburg, Luzern, Schwyz, Konstanz, Lenzburg,
  Murten, Savoyen, Frankreich, Österreich, Mailand, Strassburg, Rottweil, Rom,
  Lyon and St. Gallen;
- 12 persons, among them Ludwig von Diesbach, Sigmund and Albrecht of Austria,
  the king of France and Peterman von Raron; the others (Hans Seiler, Hans
  Keser, Hans Pfister, Hans Rot …) are common names and need checking first.

## Spot check (18.11.2026, by the agent that built the register, not by a historian)

30 place and 30 person entries with a candidate, drawn at random
(`register.py sample --seed 18112026`). For each, the letter text around the
first mention (Argon reading) and the candidate were compared. "Cannot tell"
means the letter does not say enough to decide (a common name with only an SSRQ
attestation, a field name that could be in several places). The draw of 17.11.
(seed 17112026, hmBERT register) is no longer reproducible from the current files.

| Places | right | wrong | cannot tell |
|---|---:|---:|---:|
| wahrscheinlich (13) | 9 | 2 | 2 |
| möglich (17) | 9 | 6 | 2 |

Wrong at «wahrscheinlich»:

- "die statt Brugg ynngenomen" (1444) → Brügg near Biel (it is Brugg AG, taken
  in the Old Zurich War);
- "einen brunnen ze Flueli am Buocholter berg" → Flüeli OW (a spot on the
  Buchholterberg).

Wrong at «möglich»: a person's name ("dem von Baennen" → Benken), field names
near Thun given to distant places ("ze Husen" → Hausen am Albis, "an der
lowinen" → Löuwene VS, "Martyssperg in Kellen" → Kellen AG), "grf ze Walles"
→ Valens (it is Wallis), and the Latin greeting "Salm." (salutem) → Salem.

| Persons | right | wrong | cannot tell |
|---|---:|---:|---:|
| sicher (0) | – | – | – |
| wahrscheinlich (6) | 3 | 0 | 3 |
| möglich (24) | 3 | 15 | 6 |

Right: Hans Matter, Schultheiss of Burgdorf; Heinrich and Adrian von Bubenberg;
Franz von Scharnachtal; Wolf von Brandis the elder; Peter Schopfer, Schultheiss
of Thun (only «möglich»).

Wrong at «möglich»:

- all 7 candidates from the St. Gallen register (Anna Müller → "Müller, Hans",
  Hans Kunn, chaplain at Scherzligen → "Kunz, Hans", a Thun witness Hanns Thurin
  → Hans Im Thurn of Schaffhausen …);
- another forename of the same family (Heintzman → Franz von Scharnachtal);
- «NN Kern», «NN Seiler», «NN Koler»: an SSRQ entry without a forename is no
  identification.

**Reading.** As on 17.11.: «wahrscheinlich» places (9 of 11 decided) and
persons (3 of 3 decided) look usable; «möglich» is a hint. For places about one
«möglich» in two is right, for persons one in six. Person candidates from the
St. Gallen register are wrong in every case drawn. Thirty entries a type are too
few for a percentage; R-0 (100 entries checked by a person, issue #11) is still
needed.

## Not done

- R-0: a check sample by a person, so that the grades are measured on Thun.
- R-3: the office-holder list is built ([OFFICES.md](OFFICES.md)) but not yet used:
  offices are therefore not used to join persons.
- The SSRQ place database was asked only for spellings tagged at least twice.
- The gold sample for the tagger (N-1), and with it any Thun figure for the
  tagging.
