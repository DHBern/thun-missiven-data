# Ground truth: hand transcriptions from 2016/17, and what they say about the readers

Status 18.11.2026. A Transkribus export (job 32060280, 18.11.2026) of the older Thun
collections (one document per letter, uploaded December 2016, e.g. collection 4166
"BAT_664-00100", plus the documents "GT_Thun-Training" and "GT_Thun-Test") holds hand
transcriptions of Thun letters. They were never part of collection 2329424, which the
viewer reads. Since 19.11.2026 they are published as the reader `hand-2017`
(`readings/hand-2017.jsonl`, with the Transkribus document, page and status of each page)
and shown first in the viewer on the pages they cover.

## What the export holds

| | Pages |
|---|---:|
| all pages | 515 in 131 documents |
| with a transcription not made by PyLaia | 230 |
| PyLaia output only (not ground truth) | 112 |
| empty | 173 |

"GT_Thun-Training" (238 pages) and "GT_Thun-Test" (12) repeat pages of the per-letter
documents. Taking each page once, the longest hand version: **139 pages of 126 letters,
136,078 characters**, each mapped to a page of this collection by shelfmark, number and
side (`readings/images.tsv`); one more page ("U-17_0006") maps to none and is left out. Their Transkribus status: 31 GT,
37 IN_PROGRESS, 71 NEW; 134 were last changed in 2017. None is shorter than 0.8 times
the Argon reading of the page, so none looks partial; one (BAT 663, Nr. 50 verso) is 3.8
times longer than Argon's.

## The readers measured on it

Character error rate against the hand transcription, over all pages each reader has.
"Folded": lower case, no diacritics, u/v/w, i/j/y and ß/ss joined, punctuation dropped, so
that the transcribers' conventions of 2017 count less.

| Reader | Pages | CER | CER folded |
|---|---:|---:|---:|
| Gemini 4 Argon | 139 | 12.8 % | 8.2 % |
| Joint reading (qwen3.8) | 139 | 12.8 % | 8.2 % |
| Transkribus PyLaia M2.4 | 139 | 16.4 % | 10.2 % |
| Gemini 3.8 Flash | 134 | 19.7 % | 14.0 % |

On the 12 pages of "GT_Thun-Test" (folded): Argon 15.1 %, Flash 18.0 %, PyLaia 14.6 %. On
the 127 training pages: Argon 7.4 %, Flash 13.5 %, PyLaia 9.6 %. PyLaia M2.4 is the public
model "Medieval_Scripts_M2.4", not trained on these pages; Argon and Flash know nothing of
them either. The test pages are harder for every reader; on them PyLaia is level with Argon.

This is the first Thun measurement. It agrees with St. Gallen on the order of the readers
(Argon best, the joint reading no better, Flash last) and on the joint reading adding
nothing.

## Not done

- The hand transcriptions follow the conventions of a 2017 course, not an edition; they
  are unchecked here beyond the length check.
- They are a transcription ground truth, not a tagging gold sample: issue #10 (N-1) stays
  open.
