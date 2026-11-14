# Thuner Missiven (Daten und Lesungen)

Briefe an die Stadt Thun aus dem 15. und 16. Jahrhundert, viele von Schultheiss und Rat von
Bern, im Burgerarchiv Thun (BAT), Bestände 663 bis 666.1. Die Seiten liegen in der
Transkribus-Sammlung 2329424 «BAT Thuner Missiven neu» (36 Dokumente, 5.165 Seiten).

Eine Demonstration der Universität Bern (Digital Humanities): jede Seite mit den Lesungen
automatischer Leser, umschaltbar Seite für Seite und Leser für Leser, mit Volltextsuche.
Veröffentlicht als GitHub Page: <https://dhbern.github.io/thun-missiven-data/>. Der Viewer
ist aus dem der [St. Galler Missiven](https://github.com/DHBern/sg-missiven-data) abgeleitet.

## Was veröffentlicht ist – und was nicht

- **Die Lesungen sind öffentlich, die Bilder nicht.** Die Rechte des Burgerarchivs Thun an der
  Veröffentlichung der Seitenbilder sind nicht geklärt. Die Bilder liegen weder in diesem
  Repository noch im Viewer; er zeigt nur Text.
- **Nichts hier ist Ground Truth.** Es gibt keine Edition, keine TEI, keine Register und keine
  geprüfte Transkription. Jede Lesung ist maschinell und unkorrigiert, und keine wird bewertet.
  Wo eine Seite mehrere Lesungen hat, misst der Build nur, wie stark zwei Lesungen voneinander
  **abweichen** – Abweichung, nie Qualität: Sie sagt nicht, welche der beiden recht hat.
- **Die Einheit ist die Seite.** Wo ein Brief beginnt oder endet, ist nicht bekannt. Die Seiten
  stehen nach Dokument in Signaturfolge (663, 663.1, 664, 664.1, 665, 665.1, 666, 666.1, dann
  nach Briefnummern), Seitenschlüssel `<Dokumenttitel>_p<Seite, 4-stellig>`, z. B.
  `BAT_663.1_350_399_p0005`.
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
| `readings/<leser>.jsonl` | eine Zeile pro Seite: `key`, `text` (eine Zeile pro Textzeile) |
| `readings/readers.json` | wer jeder Leser ist, mit Vorbehalten (`label`, `kind`, `about`, `caveat`; deutsch in `*_de`) |
| `readings/sources.json` | wo die Pipeline auf tei die Lesungen findet |
| `entities/<leser>.jsonl` | (noch leer) automatische Auszeichnung einer Lesung, Format wie bei St. Gallen; der Build liest sie, sobald sie da ist |
| `prompts/thun_missiven_page_v1.md` | die Anweisung an die Vision-Language-Modelle |
| `scripts/import_transkribus.py` | Transkribus-Ingest (Manifest + PAGE XML) → `pages.tsv` und die PyLaia-Lesung |
| `scripts/collect_series.py` | sammelt die Läufe auf tei (Gateway, Gemini, UBELIX) in `readings/` – fügt hinzu, entfernt nie |
| `scripts/collect_readings.py` | dasselbe für einen einzelnen Lauf, von Hand |
| `scripts/import_readings.py` | Lesungen anderer Engines übernehmen (Text, PAGE XML, ALTO, JSONL) |
| `scripts/build_site.py` | baut `site/data/` (Seiten in Teilen zu 20, Suchtext in Teilen pro Leser) |
| `scripts/pipeline.sh`, `ops/systemd/` | die Pipeline auf tei, zweimal täglich ([docs/PIPELINE.md](docs/PIPELINE.md)) |
| `site/` | der Viewer (statisch, ohne Bilder) |

```bash
uv run -p 3.12 --with rapidfuzz==3.10.1 python scripts/build_site.py
python3 -m http.server -d site 8000
```

Suche (`#/search`): Volltext über die Lesung eines Lesers, mit Facetten Signatur und Dokument.
Wörter oder `"eine Wendung"`; «Schreibvarianten zulassen» setzt u/v/w, i/y/j, ſ/s,
Doppelbuchstaben, ů/uo/u, ä/ae/a und Worttrennung am Zeilenende gleich. Die ganze Suche steht
in der URL. Der Text liegt in Teilen, die erst bei einer Suche parallel geladen werden.

Der Viewer ist zweisprachig (Deutsch/Englisch, Umschalter oben rechts); `?lang=de` oder
`?lang=en` erzwingt eine Sprache. Jeder sichtbare Text steht in `site/app.js` als
`T("English", "Deutsch")` nebeneinander.

Eine weitere Lesung hinzufügen: [docs/ADDING_READINGS.md](docs/ADDING_READINGS.md).

## Lizenz

Das Repository steht unter CC BY-SA 4.0 (`LICENSE`, wie bei St. Gallen). Die Seitenbilder gehören dem
Burgerarchiv Thun und sind nicht Teil dieses Repositorys.
