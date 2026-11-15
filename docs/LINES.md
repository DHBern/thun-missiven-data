# Lines on the image

Pointing at a line of a reading shows where that line stands on the page image,
and pointing at the image shows the line in the text. A click (on a phone: a
tap) on a line keeps it shown and brings the image to it; a click on the image
brings the text to the line (where text and image stand side by side; on a
narrow screen the image stays in view). This works for every reader: the PyLaia reading
now, the Gemini, VLM, kraken, TrOCR and olmOCR readings once they are
published. Adapted from the St. Galler Missiven viewer
([DHBern/sg-missiven-data](https://github.com/DHBern/sg-missiven-data),
`docs/LINES.md`), with one difference: the lines come from Transkribus, not
from a segmentation of our own.

## Where the lines come from

Every page has a Transkribus PAGE XML (layout analysis "Transkribus LA,
Universal Lines"): a `TextLine` with an outline (`Coords`) and a baseline for
each written line, in the pixel space of the image Transkribus serves over IIIF
(the XML's `imageWidth`/`imageHeight` equal the sizes in `readings/images.tsv`
on all 5,165 pages). The PyLaia reading was read from exactly these lines.

`scripts/import_transkribus.py` reads the PAGE XML on tei in every pipeline
cycle and writes, beside the PyLaia reading, `readings/lines.jsonl`, one page
per line:

```json
{"key": "<page key>", "size": [w, h],
 "box":  [[x0, y0, x1, y1], ...],          // each TextLine's bounding box
 "poly": [[x, y, x, y, ...], ...],         // its outline, at most 8 points
 "text": ["...", ...]}                     // its PyLaia text ("" if none)
```

The rows are the TextLines in reading order (regions by the ReadingOrder,
lines by their `readingOrder` index, as the text). Coordinates are integers in
ten-thousandths of the image **width**, on both axes: the unit OpenSeadragon
places overlays in, and independent of the size the image is served at. The
outline is the TextLine's `Coords` cut at its leftmost and rightmost points
into an upper and a lower edge, each simplified (Douglas–Peucker) with a
tolerance that grows until the whole outline has at most 8 points
(`POLY_POINTS`): enough to follow a slanted or curved line, small enough for
68,530 lines. A TextLine without a usable outline is left out; a page without
any (46 pages have no TextLines) has no entry. The import refuses to write if
fewer pages would have lines than before (as for the pages and the reading).

The PAGE XML and the manifest are never committed (the manifest names the
Transkribus user of every version); `lines.jsonl` holds no user field and is
checked like the other outputs.

## From rows to the lines of a reading

Each reading is aligned with the rows in order (`scripts/line_links.py`, taken
over unchanged from St. Gallen), as two texts are in a sequence alignment: a
line may match one row, two neighbouring rows, or two lines one row; lines and
rows may stay unmatched. The row's text is its PyLaia text. Similarity is
`rapidfuzz`'s ratio on letters only: no case, no diacritics, u/v, i/j/y and
ß/ss folded. A link needs a similarity of 0.5 (`MIN_SIM`); below it the line
stays unlinked rather than guessed. The alignment runs on the lines the viewer
shows (the reading without its empty lines), so the indices match.

For PyLaia the alignment comes out one to one: of 60,789 lines on 4,803 pages,
60,728 (99.9 %) are linked, each to the row with the identical text. The 61
others are lines without a letter or digit (`.`, `¬`, a lone abbreviation
sign), which the letters-only comparison cannot place. A page reader (Gemini,
the VLM) reads the whole page in an order of its own; it is linked as far as
its lines resemble the PyLaia lines and keep their order. Where PyLaia misread
a line badly, a good reading of it may stay unlinked: the rows' text is
PyLaia's.

## In the viewer

`build_site.py` writes the geometry into the letter chunks, so a letter loads
only its own pages' lines: per page `rows` (each row's outline, as in
`lines.jsonl`) and beside every reading `ln`: per line the rows it is linked
to, `[]` where none. The reading's head says how many of its lines are linked.
The highlight is drawn as an SVG polygon in an OpenSeadragon overlay, once the
image has opened; the image is still loaded from Transkribus and can be slow.
Pointing at the image finds the row whose outline holds the pointer. In the
comparison view the links follow the selected reading.

## Size

The outlines add about 4 MB to the letter chunks (4.5 MB before, 9.1 MB after;
1.4 MB and 3.6 MB gzip-compressed), about 35 kB compressed per chunk of 25
letters. `readings/lines.jsonl` itself is 9.1 MB (3.8 MB compressed).

## What it cannot do

A line the layout analysis did not find has no row; text in the margin or
written at an angle is linked only if Transkribus found a line there. A verso
whose ink shows through from the recto may have rows on the mirror-image
writing, and PyLaia text for them. A reading that orders lines differently
from top to bottom (an address on the side, a postscript) is linked only as
far as the order agrees.
