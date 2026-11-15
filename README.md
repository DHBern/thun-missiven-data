# Thuner Missiven (Daten und Lesungen)

Briefe an die Stadt Thun aus dem 15. und 16. Jahrhundert, viele von Schultheiss und Rat von
Bern, im Burgerarchiv Thun (BAT), Bestände 663 bis 666.1. Die Seiten liegen in der
Transkribus-Sammlung 2329424 «BAT Thuner Missiven neu» (36 Dokumente, 5.165 Seiten).

Eine Demonstration der Universität Bern (Digital Humanities): 2.549 Briefe, jeder mit den
Bildern seiner Seiten (von Transkribus), den Lesungen automatischer Leser, umschaltbar Seite für
Seite und Leser für Leser, und – wo es eines gibt – einem maschinell entworfenen Regest; mit
Volltextsuche.
Veröffentlicht als GitHub Page: <https://dhbern.github.io/thun-missiven-data/>. Der Viewer
ist aus dem der [St. Galler Missiven](https://github.com/DHBern/sg-missiven-data) abgeleitet.

## Was veröffentlicht ist – und was nicht

- **Die Bilder zeigt der Viewer, ausgeliefert von Transkribus.** Die Digitalisierung erfolgte
  durch die Universität Zürich (Lehrstuhl Prof. Simon Teuscher). Die Bilder liegen nicht in diesem
  Repository; der Viewer lädt sie über IIIF von `files.transkribus.eu` (`readings/images.tsv`).
- **Nichts hier ist Ground Truth.** Es gibt keine Edition, keine TEI, keine Register und keine
  geprüfte Transkription. Jede Lesung ist maschinell und unkorrigiert, und keine wird bewertet.
  Wo eine Seite mehrere Lesungen hat, misst der Build nur, wie stark zwei Lesungen voneinander
  **abweichen** – Abweichung, nie Qualität: Sie sagt nicht, welche der beiden recht hat.
- **Die Einheit ist der Brief.** Die Transkribus-Dokumente (je rund hundert Briefe) sind nach
  den Dateinamen der Aufnahmen in Briefe getrennt, die Signatur, Nummer und Seite tragen
  (`BAT_666.1_500_r.png`: BAT 666.1, Nr. 500, Recto; `scripts/letters.py`). Die Briefe stehen in
  Signaturfolge (663, 663.1, 664, 664.1, 665, 665.1, 666, 666.1, dann nach Nummern), Brief-ID
  z. B. `bat_666-1_500`. Neun Briefe sind ein zweites Mal aufgenommen; diese Aufnahmen zeigt der
  Viewer nach den Seiten als «weitere Aufnahme». Seitenschlüssel bleiben
  `<Dokumenttitel>_p<Seite, 4-stellig>`, z. B. `BAT_663.1_350_399_p0005`; alte Seitenlinks
  (`#/doc/<Dokument>/<Seite>`) führen zum Brief.
- **Überschriften und Regesten sind Maschinenentwürfe.** Ein offenes Sprachmodell (Qwen3.8-27B
  auf dem GPUStack der Universität Bern) entwirft sie aus der besten vorhandenen Lesung eines
  Briefs, mit Briefen der St. Galler Edition als Stilvorlagen (`scripts/regest.py`,
  `regests/drafts.jsonl`). Niemand hat sie geprüft; der Viewer kennzeichnet jeden Entwurf als
  solchen und nennt Lesung und Modell. Bisher haben erst einige Briefe einen Entwurf.
- Keine Personendaten: Die Benutzernamen und E-Mail-Adressen, die Transkribus zu jeder
  Transkriptversion führt, werden beim Import verworfen (`scripts/import_transkribus.py` bricht
  ab, wenn eine Ausgabe eine E-Mail-Adresse enthielte).

## Leser

| Leser | Stand |
|---|---|
| Transkribus · PyLaia M2.4 (`transkribus-pylaia-m2.4`): Layout Transkribus LA «Universal Lines», Text PyLaia, Modell 42143 «Medieval_Scripts_M2.4», meist mit, teils ohne Sprachmodell; Status IN_PROGRESS, nie korrigiert | veröffentlicht |
| Gemini 4 Argon, Gemini 3.8 Flash (Prompt `prompts/thun_missiven_page_v1.md`) | geplant |
| Qwen3.5-4B, feinjustiert auf Kurrent (ganze Seiten) | geplant |
| kraken (Berner Kanzlei, Kursive Inzigkofen) | geplant |
| TrOCR (Kurrent XVI–XVII, mittelalterlich) | geplant |
| Automatische Auszeichnung von Personen, Orten, Daten (NER) und Verknüpfung mit Normdaten | geplant |

## Inhalt

| Pfad | Inhalt |
|---|---|
| `readings/pages.tsv` | alle Seiten in Signaturfolge: Schlüssel, Dokument, Seite, Bildgrösse, Zeilen, PyLaia-Variante (`lm`/`none`) |
| `readings/letters.tsv` | die Briefe in Signaturfolge: `id`, `shelf`, `nr`, `title`, `doc`, `pages` (Seitenschlüssel), `sides` (`r;v`, `r1;r2;v1;v2` …), `extra` (weitere Aufnahmen) |
| `readings/images.tsv` | eine Zeile pro Seite: Brief, Seite (r/v), Vermerk, Bilddatei, `tk` (IIIF-Kennung auf `files.transkribus.eu`), Bildgrösse |
| `regests/drafts.jsonl` | maschinell entworfene Überschrift und Regest pro Brief (die letzte Zeile gilt), mit Lesung, Modell und Prompt |
| `readings/<leser>.jsonl` | eine Zeile pro Seite: `key`, `text` (eine Zeile pro Textzeile) |
| `readings/readers.json` | wer jeder Leser ist, mit Vorbehalten (`label`, `kind`, `about`, `caveat`; deutsch in `*_de`) |
| `readings/sources.json` | wo die Pipeline auf tei die Lesungen findet |
| `readings/lines.jsonl` | die Zeilen jeder Seite aus dem Transkribus-Layout: Rahmen, Umriss (höchstens 8 Punkte), PyLaia-Text; Koordinaten in Zehntausendsteln der Bildbreite ([docs/LINES.md](docs/LINES.md)) |
| `entities/<leser>.jsonl` | (noch leer) automatische Auszeichnung einer Lesung, Format wie bei St. Gallen; der Build liest sie, sobald sie da ist |
| `prompts/thun_missiven_page_v1.md` | die Anweisung an die Vision-Language-Modelle |
| `scripts/import_transkribus.py` | Transkribus-Ingest (Manifest + PAGE XML) → `pages.tsv`, die PyLaia-Lesung und `lines.jsonl` |
| `scripts/line_links.py` | ordnet die Zeilen einer Lesung den Zeilen im Bild zu (von St. Gallen übernommen) |
| `scripts/collect_series.py` | sammelt die Läufe auf tei (Gateway, Gemini, UBELIX) in `readings/` – fügt hinzu, entfernt nie |
| `scripts/collect_readings.py` | dasselbe für einen einzelnen Lauf, von Hand |
| `scripts/import_readings.py` | Lesungen anderer Engines übernehmen (Text, PAGE XML, ALTO, JSONL) |
| `scripts/letters.py` | trennt die Dokumente nach den Bilddateinamen in Briefe → `letters.tsv`, `images.tsv` |
| `scripts/regest.py` | entwirft Überschrift und Regest pro Brief (Qwen3.8-27B, GPUStack Universität Bern) → `regests/drafts.jsonl` |
| `scripts/build_site.py` | baut `site/data/` (Briefe in Teilen zu 25, Suchtext in Teilen pro Leser) |
| `scripts/pipeline.sh`, `ops/systemd/` | die Pipeline auf tei, zweimal täglich ([docs/PIPELINE.md](docs/PIPELINE.md)) |
| `site/` | der Viewer (statisch; Bilder per IIIF von Transkribus, OpenSeadragon) |

```bash
uv run -p 3.12 --with lxml==5.3.0 --with rapidfuzz==3.10.1 python scripts/build_site.py
python3 -m http.server -d site 8000
```

Ein Brief: `#/letter/<id>/<Seite>/<Leser>`, z. B. `#/letter/bat_663_217/1`.

Suche (`#/search`): Volltext über die Lesung eines Lesers, Brief für Brief, mit Facetten
Signatur, Jahrzehnt, Absender, Empfänger und Regest (die letzten vier aus den Maschinenentwürfen);
ohne Suchwort wählen die Facetten allein Briefe aus.
Wörter oder `"eine Wendung"`; «Schreibvarianten zulassen» setzt u/v/w, i/y/j, ſ/s,
Doppelbuchstaben, ů/uo/u, ä/ae/a und Worttrennung am Zeilenende gleich. Die ganze Suche steht
in der URL. Der Text liegt in Teilen, die erst bei einer Suche parallel geladen werden.

Der Viewer ist zweisprachig (Deutsch/Englisch, Umschalter oben rechts); `?lang=de` oder
`?lang=en` erzwingt eine Sprache. Jeder sichtbare Text steht in `site/app.js` als
`T("English", "Deutsch")` nebeneinander.

Text und Bild sind Zeile für Zeile verknüpft: Der Zeiger auf einer Zeile der Lesung zeigt sie
im Bild, der Zeiger im Bild die Zeile im Text; ein Klick oder Tippen auf eine Zeile führt das
Bild zu ihr. Die Zeilen sind die TextLines des Transkribus-Layouts (Umriss aus dem PAGE XML,
`readings/lines.jsonl`); jede Lesung wird ihnen nach dem Textvergleich zugeordnet, wie bei den
St. Galler Missiven – bei PyLaia 99,9 % der Zeilen ([docs/LINES.md](docs/LINES.md)).

Eine weitere Lesung hinzufügen: [docs/ADDING_READINGS.md](docs/ADDING_READINGS.md).

## Lizenz

Das Repository steht unter CC BY-SA 4.0 (`LICENSE`, wie bei St. Gallen). Die Seitenbilder sind nicht
Teil dieses Repositorys; die Digitalisierung erfolgte durch die Universität Zürich (Lehrstuhl
Prof. Simon Teuscher).
