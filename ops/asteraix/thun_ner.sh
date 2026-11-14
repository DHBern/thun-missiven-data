#!/usr/bin/env bash
# asteraix, daily timer: once the Thun Argon reading is published (>= 95 % of the pages)
# and the second A40 is free, train the St. Gallen NER model on this GPU (5 folds + final,
# sg-missiven-data scripts/ner.py run), tag + link the Thun pages (thun_ner.py), and open
# a pull request on DHBern/thun-missiven-data. Runs once; marker ~/thun-ner/done.
set -euo pipefail
W=$HOME/thun-ner; mkdir -p "$W"; cd "$W"
exec 9>"$W/lock"; flock -n 9 || exit 0
[ -e "$W/done" ] && exit 0
log() { echo "$(date -Is) $*" | tee -a "$W/status.log"; }
[ "$(date +%s)" -ge "$(date -d "${NER_FROM:-2026-11-19 06:00}" +%s)" ] || exit 0
export PATH=$HOME/.local/bin:$PATH; gh auth setup-git >/dev/null 2>&1 || true
rm -rf thun && git clone -q --depth 1 https://github.com/DHBern/thun-missiven-data thun
R=thun/readings/gemini-4-argon.jsonl
total=$(($(wc -l < thun/readings/pages.tsv) - 1)); have=$( [ -f $R ] && wc -l < $R || echo 0)
[ $((have * 100)) -ge $((total * 95)) ] || { log "waiting: Argon reading $have / $total pages"; exit 0; }
GPU=${NER_GPU:-1}
used=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits -i "$GPU")
[ "$used" -lt 2000 ] || { log "waiting: GPU $GPU in use ($used MiB)"; exit 0; }
[ -x "$HOME/.venvs/thun-ner/bin/python" ] || { uv venv -q --python 3.12 "$HOME/.venvs/thun-ner" && \
  uv pip install -q --python "$HOME/.venvs/thun-ner/bin/python" torch==2.13.0 transformers==5.20.0 rapidfuzz lxml; }
PY=$HOME/.venvs/thun-ner/bin/python
rm -rf sg && git clone -q --depth 1 https://github.com/DHBern/sg-missiven-data sg
sed -i 's/device = "mps" if torch.backends.mps.is_available() else "cpu"/device = "cuda" if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else "cpu")/' sg/scripts/ner.py
grep -q 'device = "cuda"' sg/scripts/ner.py || { log "STOP: could not switch ner.py to CUDA"; exit 1; }
log "training on GPU $GPU ($have Thun pages read)"
(cd sg && CUDA_VISIBLE_DEVICES=$GPU $PY scripts/ner.py run --reader gemini-4-argon) > "$W/train.log" 2>&1
log "trained: $(tail -1 "$W/train.log")"
CUDA_VISIBLE_DEVICES=$GPU $PY "$W/thun_ner.py" sg thun gemini-4-argon > "$W/tag.log" 2>&1
log "tagged: $(tail -1 "$W/tag.log")"
mkdir -p "$W/keep" && cp -r sg/models/ner-gemini-4-argon sg/entities/gemini-4-argon.report.json "$W/keep/"
cd thun && git switch -q -c data/ner-$(date +%Y%m%d) && git add entities && \
  git commit -q -m "entities: NER + links for the Argon reading (St. Gallen model, trained on asteraix)" && \
  git push -q origin HEAD && gh pr create -R DHBern/thun-missiven-data --fill --body "$(tail -1 "$W/tag.log")

Trained on asteraix by ops/thun_ner.sh. Not measured on Thun: there is no Thun tagging. Links are to the St. Gallen registers, only of the kinds measured at precision >= 0.9 there, all cert=medium; persons only with a year read on the page." >> "$W/status.log"
touch "$W/done"; log "done"
