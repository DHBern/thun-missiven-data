# Register: persons, places and organisations (generated automatically)

Status 17.11.2026. Plan steps R-1, R-2, R-4 and R-5 of
[NER_REGISTER_PLAN.md](NER_REGISTER_PLAN.md); R-0 (a check sample made by a
person) and R-3 (office holders by year) are **not done**.

The Thun Missives have no edition and no register. Everything here is
**generated automatically** from the tagging in `entities/gemini-4-argon.jsonl`.
That tagging comes from St. Gallen's hmBERT model on the Gemini 4 Argon reading,
and the model has **not been measured on Thun**. Every link is a proposal,
graded by the rules St. Gallen wrote and measured for its own generated entries
(DHBern/sg-missiven-data `docs/REGISTER.md`, `scripts/auto_register.py`,
`scripts/ssrq_match.py`). No person has checked any of it.

## Outputs

| File | Content |
|---|---|
| `registers/places.json` | 1,376 places |
| `registers/persons.json` | 4,631 persons |
| `registers/orgs.json` | 276 organisations |
| `links/registers/st-gallen.json` | 213 links from Thun entries to entries of the St. Gallen register (Thun side only) |
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

18,564 tagged names of type person, organisation or place.

- **Places.** Names are folded as in St. Gallen (u/v/w, i/y, doubled letters,
  ph/f, th/t, tz/z, ck/k, ä/e …). A trailing inflection joins its stem (Berne →
  Bern, Thuno → Thun). Spellings whose best candidate names the same settlement
  at grade «wahrscheinlich» (same HLS or SSRQ id) become one entry. A spelling
  graded only «möglich» stays its own entry: «Ober- hofen» is not joined to
  Oberhofen. Dropped: 55 forenames tagged as places (Clewi, Uelli).
- **Organisations.** The address formula is normalised to the form the St. Gallen
  register uses. "Schulths und rat ze Berne", "Schultheis und der Rat der Statt
  Bern" and "Schulths und rat ze Brn" all become «Schultheiss und Rat zu Bern».
  The place inside the formula is read through the place entries, with the
  scribes' abbreviations of Bern. "Rat zu X", "die von X" and "zuo Thun" fold
  into «Schultheiss und Rat zu X» where that body is named. Other names are
  grouped by spelling (≥ 90). Dropped: 445 titles or offices alone ("Schulthes",
  "Schultheissen"), 37 formulas without a place, 14 fragments.
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
  | bare forenames, also spelled otherwise (Peter, Hensli, Burckart) | 1,280 |
  | names that are a place's (Thun, Inderlapen, Kander) | 302 |
  | titles or offices alone (Schulthes, alt, bapst) | 326 |
  | particles (von, und) | 55 |
  | fragments | 30 |

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

### The run of 17.11.2026

| | sicher | wahrscheinlich | möglich | no candidate |
|---|---:|---:|---:|---:|
| Places (1,376) | – | 220 | 364 | 792 |
| Persons (4,631) | 14 | 47 | 156 | 4,414 |
| Organisations (276) | – | 10 | 42 | 224 |

Best candidate by source:

- **Places:**
  - HLS: 179 wahrscheinlich, 284 möglich;
  - SSRQ: 82 / 105;
  - St. Gallen: 35 / 6;
  - Königsfelden: 15 / 9.
- **Persons:**
  - HLS: 14 sicher, 2 wahrscheinlich, 9 möglich;
  - SSRQ: 35 wahrscheinlich, 85 möglich;
  - Königsfelden: 19 / 16;
  - St. Gallen: 8 / 63.
- **Organisations:**
  - St. Gallen: 10 wahrscheinlich, 9 möglich;
  - SSRQ: 5 / 34;
  - Königsfelden: 3 / 6.

A candidate found in several sources counts for each of them.

Most entries have no candidate. Most are spellings tagged once (1,001 of the
places), and most persons in these letters are burghers of Thun and the
Oberland, who are in no authority file.

**The largest entries:**

| Entry | Letters | Best candidate |
|---|---:|---|
| «Schultheiss und Rat zu Thun» | 1,723 | none: the SSRQ and St. Gallen have no such body; St. Gallen has «Bürgermeister und Rat zu Thun», proposed as «möglich» |
| «Schultheiss und Rat zu Bern» | 1,701 | wahrscheinlich: St. Gallen, SSRQ and Königsfelden agree on org004002 |
| Thun | 678 | HLS 000541, wahrscheinlich |
| Bern | 232 | wahrscheinlich |
| Basel | 55 | wahrscheinlich |
| Oberhofen | 54 | Oberhofen am Thunersee, wahrscheinlich |

## Coordinates and the map

Coordinates come **only** from a matched candidate, never from a name alone:

- the St. Gallen register (34 places);
- an HLS article on our server (96);
- Wikidata, by the candidate's HLS id (83).

So 213 places have coordinates from a candidate graded «wahrscheinlich». The
overview map shows these. 316 more have coordinates only from a «möglich»
candidate; the map shows them on request, dashed. Places named in the letters
on the map: 1,333 letters.

1,163 places are not on the map. They are listed in
[places_without_coordinates.md](places_without_coordinates.md) with the reason
for each.

## R-5: St. Gallen

`links/registers/st-gallen.json` lists 213 links:

- **Places, 95:**
  - 56 to entries of the St. Gallen register, 35 of them «wahrscheinlich»;
  - 39 to St. Gallen generated entries whose best candidate is the same HLS
    article.
- **Organisations, 20:** «Schultheiss und Rat zu Bern», Solothurn, Luzern …;
  10 of them «wahrscheinlich».
- **Persons, 98:** 89 of them only «möglich». The spot check below finds these
  mostly wrong.

The viewer shows the link on the Thun entry page (to `#/entry/<id>` on the
St. Gallen site). No change was made to sg-missiven-data.

Candidates for a reverse link from St. Gallen, if wanted, are the entries
graded «wahrscheinlich» or better:

- «Schultheiss und Rat zu Bern» = `stadtasg-actors-514`;
- the places Zürich, Freiburg, Luzern, Konstanz, Lenzburg, Savoyen, Frankreich,
  Österreich, Aargau, Unterwalden, Murten, Erlach, Zug, Appenzell, St. Gallen;
- the persons Ludwig von Diesbach and Sigmund von Habsburg-Österreich.

## Spot check (17.11.2026, by the agent that built the register, not by a historian)

30 place and 30 person entries with a candidate, drawn at random (seed
17112026, `register.py sample`). For each, the letter text around the first
mention and the authority record were compared. "Cannot tell" means that the
letter does not say enough to decide (a common name with only an SSRQ
attestation).

| Places | right | wrong |
|---|---:|---:|
| wahrscheinlich (10) | 9 | 1: "Henslin underm Berg" → Berg am Irchel, a surname |
| möglich (20) | 9 | 11 |

The 11 wrong places include:

- "zwischen Bern und Mure" → Mürren (it is Muri);
- "ex castro Meyerie" → Meyrin (the Majorie at Sion);
- "Boenikon" → Böbikon (Bönigen?);
- "Honberg" → Hornberg (Homberg near Thun);
- "Langeneg" → Langenegg AR (a Langenegg near Thun);
- "Sant Niclaus" → a church in St. Gallen (it is a feast day).

| Persons | right | wrong | cannot tell |
|---|---:|---:|---:|
| sicher (3) | 3 | 0 | 0 |
| wahrscheinlich (7) | 4 | 1: "Claws Schmid von Sigriswil" → a Königsfelden Klaus Schmid | 2 |
| möglich (20) | 2 | 12 | 6 |

The persons right at «sicher» and «wahrscheinlich» were Rudolf and Thüring von
Ringoltingen, Rudolf von Erlach, Rudolf Hofmeister, Niklaus von Scharnachtal,
Hartmann vom Stein and Sigmund of Austria: Bern's Schultheissen and
councillors, and princes.

Wrong at «möglich»:

- an occupation tagged as a name ("dem mueller" → Hans Müller);
- common names joined to namesakes in St. Gallen or Zürich (Heini Schmid, Hans
  Schnider, Hans Scher → Hans Schwyzer).

**Reading.** On Thun, «wahrscheinlich» places (9/10) and «sicher» persons (3/3)
look as good as in St. Gallen. «Möglich» is a hint, not an identification: for
places about one in two is right, for persons about one in ten. Person
candidates from the St. Gallen register are weak; 9 of the 20 «möglich» persons
came from it. Thirty entries a type are too few for a percentage; R-0 (100
entries checked by a person) is still needed.

## Not done

- R-0: a check sample by a person, so that the grades are measured on Thun.
- R-3: office holders by year (Schultheissen of Thun and Bern, Stadtschreiber);
  offices are therefore not used to join persons.
- The SSRQ place database was asked only for spellings tagged at least twice.
- The gold sample for the tagger (N-1), and with it any Thun figure for the
  tagging.
