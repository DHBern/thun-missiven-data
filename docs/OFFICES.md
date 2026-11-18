# Office holders: Schultheissen of Thun and Bern, Stadtschreiber of Bern

Plan step R-3 of [NER_REGISTER_PLAN.md](NER_REGISTER_PLAN.md), issue #12. Status 18.11.2026:
the list is built and checked against Wikidata and the letters. It is **not yet used** by the
register (joining persons by office) or by the dates.

`scripts/offices.py` writes `registers/offices.json` from:

| Input | What |
|---|---|
| `registers/offices_wikipedia.tsv` | three German Wikipedia lists as they stood on 18.11.2026, up to 1798: [Schultheiss von Bern](https://de.wikipedia.org/wiki/Schultheiss_von_Bern) (88 entries), [Liste der Schultheissen von Thun](https://de.wikipedia.org/wiki/Liste_der_Schultheissen_von_Thun) (103), [Liste der Stadtschreiber von Bern](https://de.wikipedia.org/wiki/Liste_der_Stadtschreiber_von_Bern) (48). CC BY-SA 4.0, Wikipedia contributors. |
| `registers/offices_wikidata.json` | for each name up to 1600, the Wikidata item a name search finds (a human whose description names Bern, Thun or the office, or with an HLS id), with birth, death and HLS id |
| the letters | the Argon reading: a name next to «schultheis ze Thun/Bern» or «statschriber», and the letter's year from `dates/dates.jsonl` |

Every holder carries its list years, the Wikidata item (if one fits), the letters that name
them in office, automatic flags, and, where the agent read the evidence, a `review`. The
Thun list gives one year per holder (the first); the Bern lists give first and last years.

## Wikidata

Wikidata hardly models these offices. The query service finds six people with an office
statement (P39) for Bern and none for Thun or the Stadtschreiber; "Schultheiss von Bern"
(Q2251605) has four holders. A name search finds an item for 48 of the 138 names up to
1600; 36 of them are kept. Nine are namesakes from another century and are dropped by rule
(the office more than 50 years from the person's life): a bishop of Aosta for
"Burchardus" (Stadtschreiber 1263), a textile manufacturer born 1835 for "Johannes Blum"
(1439), a conductor for "Rudolf Baumgartner" (1500). Three more were recognised as
namesakes by reading (Ludwig von Diesbach, Christian Willading, Niklaus Zurkinden), and
the Bern Schultheiss Niklaus Dachselhofer (1595–1670) is kept for Bern but not for the Thun
Schultheiss of 1596; all are recorded in `REVIEW` in the script.

## Contradictions

Read by the agent on the Argon text and the list, not by a historian. "Year written out"
means the letter writes the century; otherwise `dates.py` took it from the neighbouring
letters in the volume, and it can be wrong by a decade or a century.

### The Thun list against the letters

| Holder | List | Letters | Reading |
|---|---|---|---|
| Peter Schopfer | 1440; Niklaus von Wattenwyl 1444, Kaspar von Scharnachthal 1449 | Schultheiss of Thun from 3.10.1439 (BAT 664, Nr. 48) to 1448, in 59 letters with the year written out (1439: 3, 1440: 16, 1441: 10, 1442: 11, 1443: 6, 1444: 2, 1445: 9, 1447: 1, 1448: 1) | in office 1439–1448 at least; no letter names Wattenwyl as Schultheiss |
| Kaspar von Scharnachthal | 1449; then Ulrich von Laupen 1455, Ulrich von Erlach 1456, Niklaus von Scharnachthal 1458, Ludwig Brüggler 1459 | 1450–1461, 1461 written out (BAT 665, Nr. 52) | in office into the 1460s. Two letters dated 1400 and 1403, years written out (BAT 665, Nr. 90, 99), name «junkher Caspar von Scharnachtal schultheis ze Thun»: an earlier Kaspar, or a misread year; to check on the image |
| Ulrich von Laupen | 1455 only | ten letters dated 1463–1477 (centuries from neighbours) | in office in the 1460s and 1470s |
| Ludwig Brüggler | 1412, 1459, 1471 (II.) | 1454–1462; letters dated 1370/1371/1378 are 1470s with the century taken wrongly | in office from 1454, earlier than the list's 1459 |
| Gilian Achshalm | 1476; Thüring von Erlach 1478 | 1472–1488 (centuries from neighbours) | in office longer than the list says |
| Antoni Bütschelbach | 1518; Urban Baumgartner 1520 | signs as Schultheiss in 1521, year written out (BAT 666.1, Nr. 455) | in office until 1521 at least |
| Ludwig von Diesbach | 1482 | one letter of 1472, year written out (BAT 666, Nr. 142) | 1472 may be 1482 misread; to check |

**Not in the Thun list at all**, named as Schultheiss of Thun in an address or signature:

- Rudolf von Speichingen, ten letters, 1463–1475 (centuries from neighbours), in the same
  years as Ulrich von Laupen: the two alternated, or some years are wrong.
- Members of the von Laupen family with other forenames: Jörg (1464, 1480), Thüring
  (1469), Mathe (1476), Ludwig (1477). Each once; they may be misreadings of «Uolrichen»
  and are to check on the image.
- Single letters: Anton Bulen (1411), Hans Frutigen (1444), Ludwig Hemberg (1445),
  Rudolf von Scharnachtal (1465), Peter Segentzer (1474), Peter Ysenhuot (1477),
  Peterman von Gruyères (1490; the list has Jakob von Wattenwyl), Ludwig Trinn (1525).
  Each needs the image before it means anything.

Not a contradiction, though flagged: Hans von Erlach in 1412 and Niklaus von Wattenwyl in
1439 are named without an office; Jacob Michel is called «dozemaln unserm schultheissen …
salig» in 1577, Schultheiss at that time and now dead. «Stoupfer», «Steppher» and «Bernner
Schopfer» are readings of Schopfer; «Kachelhofer» (1602) is Dachselhofer (list 1596).

### The Bern lists against the letters

- **Stadtschreiber Heinrich von Speichingen**: the list has him to 1439 and Johannes Blum
  from 1439; he signs as Stadtschreiber of Bern in 1441, year written out (BAT 663.1, Nr. 396).
- **Schultheiss Rudolf von Erlach**: the list has him to 1507; a letter he signs as
  «schulthes zuo Bernn» is dated 1508, century from neighbours (BAT 666.1, Nr. 412).
- Rudolf Hofmeister (15 letters, 1437–1446), Kaspar vom Stein («alt Schultheis», 1461) and
  Heinrich Matter agree with the list.

### Within and between the Wikipedia lists

- The Bern Schultheiss list gives first and last years; the Schultheissen alternated, so
  the ranges overlap: in 1470–1471 five names (Scharnachthal, Diesbach, Bubenberg,
  Kistler, Wabern), in 1495–1498 three (Rudolf von Erlach, Wilhelm von Diesbach, Heinrich
  Matter). For a given year the list does not say who presided.
- Stadtschreiber 1593: three names (Johann Kaufmann to 1593, Uriel Herport 1593, Jakob
  Bucher from 1593). Konrad Justinger and Heinrich Gruber both 1400.
- Thun: two holders with the same year, 1528 (Rudolf von Erlach, Hans Strähler) and 1644
  (Abraham von Werdt, Albrecht von Erlach).
- Wilhelm von Diesbach is Schultheiss of Thun in 1509 by one list and Schultheiss of Bern
  1481–1517 by the other. Ulrich von Erlach is Schultheiss of Bern to 1456 and of Thun from
  1456. The Rudolf von Erlach of Thun 1528 is not the Bern Schultheiss of 1479–1507, who died
  in 1507.

### Wikidata against the lists, and against itself

- Otto von Bubenberg: Schultheiss of Bern to 1393 by the list; died 1392 by Wikidata
  (Q88264746).
- Samuel Zurkinden (Q78076307): died 1553 by its date statement, 24.9.1577 by its own
  description; the list has him as Stadtschreiber to 1577.
- Peter Kistler (Q1379653): born 1500, died 1480 by Wikidata; Schultheiss of Bern 1470–1471.

## A date fixed on the way

BAT 666.1, Nr. 439 a and b (Berchtold Vogt) write the year as «1. 5. 72»: 1572. `dates.py`
read neither and took 1506 and 1507 from the neighbouring letters; it now reads 1572, which
fits the list (Berchtold Vogt 1571).

## Not done

- The register does not use the list yet: Peter Schopfer is still two entries (1410–1440
  and 1441–1471) because offices are not used to join persons.
- Letters whose year is uncertain are not dated by the office holder they name.
- The suspicious single names above are not checked on the images.
