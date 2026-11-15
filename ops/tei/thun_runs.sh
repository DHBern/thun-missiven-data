#!/usr/bin/env bash
# Thun Missiven: start the reading runs in order, one step per call (systemd timer, hourly).
#   1. ingest complete (Transkribus collection 2329424 -> share)
#   2. Gemini test: Argon + Flash on 200 sampled pages (needs prompt thun_missiven_page_v1.md
#      on tei and a Gemini project under its spending cap)
#   3. Gemini full: the same run over every page, if the test passed its sanity check
#   4. from GATEWAY_FROM, and only while no SG Missiven gateway run is active:
#      VLM, kraken, TrOCR on the gateway (idhefix), one after the other
# Each run is resumable: a failed step is simply started again at the next call.
# Status: ~/thun-runs/status.log; per-step logs ~/thun-runs/<step>.log; markers <step>.done
set -uo pipefail
AH=$HOME/agentic_historian
PY=$AH/.venv/bin/python3
ST=$HOME/thun-runs
SRC=/mnt/wbkolleg_dh_1/tei/datasets/thun-missiven-images/pages
VT=$AH/agentic_historian/data/vlm_test
PROMPT=thun_missiven_page_v1.md
GATEWAY_FROM=${GATEWAY_FROM:-2026-11-19 06:00}
mkdir -p "$ST"
exec 9>"$ST/lock"; flock -n 9 || exit 0
log() { echo "$(date -Is) $*" | tee -a "$ST/status.log"; }
active() { systemctl --user is-active --quiet "thun-$1"; }
start() {  # start <step> <atr-batch args...>
  local step=$1; shift
  systemd-run --user --unit="thun-$step" --collect --quiet -p Nice=10 -p MemoryMax=1500M \
    -p OOMPolicy=continue --working-directory="$AH" \
    /bin/bash -c "PYTHONUNBUFFERED=1 $PY -m agentic_historian atr-batch $* >> $ST/$step.log 2>&1 && touch $ST/$step.done"
  log "started $step: $*"
}
pages() { ls "$VT/$1/$2" 2>/dev/null | grep -c '\.txt$'; }

# 1. ingest
if [ ! -e "$ST/ingest.done" ]; then
  if grep -q '^done:' "$HOME/thun-missiven-ingest/ingest.log" 2>/dev/null; then touch "$ST/ingest.done"; log "ingest complete"
  else log "waiting: ingest"; exit 0; fi
fi
TOTAL=$(ls "$SRC" | grep -c '\.jpg$')

# 2. Gemini test (200 pages)
if [ ! -e "$ST/gemini-test.done" ]; then
  active gemini-test && exit 0
  [ -f "$AH/agentic_historian/prompts/$PROMPT" ] || { log "waiting: prompt $PROMPT not on tei (thodel/agentic_historian#873)"; exit 0; }
  start gemini-test --source "$SRC" --models gemini-4-argon,gemini-3.8-flash --run thun-missiven-gemini-v1 \
    --sample 200 --concurrency 8 --via external --prompt "$PROMPT" --reasoning low --no-listing-cache
  exit 0
fi

# 3. Gemini full, after a sanity check of the test: >= 190 pages per model, <= 10 % empty
if [ ! -e "$ST/gemini-full.done" ]; then
  active gemini-full && exit 0
  if [ ! -e "$ST/gemini-test.ok" ]; then
    ok=1
    for m in gemini-4-argon gemini-3.8-flash; do
      n=$(pages thun-missiven-gemini-v1 $m)
      empty=$(find "$VT/thun-missiven-gemini-v1/$m" -name '*.txt' -size -20c 2>/dev/null | wc -l)
      log "test $m: $n pages, $empty empty"
      { [ "$n" -ge 190 ] && [ $((empty * 10)) -le "$n" ]; } || ok=0
    done
    [ $ok = 1 ] || { log "STOP: Gemini test failed its sanity check; full run not started"; exit 0; }
    touch "$ST/gemini-test.ok"
  fi
  start gemini-full --source "$SRC" --models gemini-4-argon,gemini-3.8-flash --run thun-missiven-gemini-v1 \
    --limit 20000 --concurrency 8 --via external --prompt "$PROMPT" --reasoning low
  exit 0
fi

# 4. gateway runs, after SG has finished with the gateway
[ "$(date +%s)" -ge "$(date -d "$GATEWAY_FROM" +%s)" ] || exit 0
if pgrep -af 'agentic_historian atr-batch' | grep -v -- '--via external' | grep -q 'sg-missiven'; then
  log "waiting: an SG Missiven gateway run is still active"; exit 0
fi
for step in vlm kraken trocr; do
  [ -e "$ST/$step.done" ] && continue
  active "$step" && exit 0
  case $step in
    vlm)    start vlm --source "$SRC" --models qwen3.5-4b-german-kurrent-xvi-xix-page-v1 --run thun-missiven-vlm-v1 ;;
    kraken) start kraken --source "$SRC" --models kraken-bern-combined-v1,kraken-cursive_inzigkofen --run thun-missiven-kraken-v1 ;;
    trocr)  start trocr --source "$SRC" --models trocr-medieval-escriptmask,trocr-kurrent-xvi-xvii --run thun-missiven-trocr-v1 ;;
  esac
  exit 0
done
[ -e "$ST/all.done" ] || { touch "$ST/all.done"; log "all tei-started runs done ($TOTAL pages)"; }
