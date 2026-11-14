#!/bin/bash
# Thun Missiven: olmOCR (fine-tuned, Kurrent XVI-XIX + BLB) on the Transkribus originals, one H100.
#   sbatch --begin=2026-11-19T06:00 --array=0-2 --export=ALL,SHARDS=3 recognize_thun.sbatch
# Resumable: start the same shard again and it skips the pages already in its output.
# Output lands on the research share, where the tei pipeline collects it:
#   /storage/research/wbkolleg_dh_1/tei/thun-readings/ubelix/<model>/shard-<i>-of-<n>.jsonl
#SBATCH --job-name=thun-read
#SBATCH --account=gratis
#SBATCH --partition=gpu
#SBATCH --qos=job_gratis
#SBATCH --gres=gpu:h100:1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=64G
#SBATCH --time=08:00:00
#SBATCH --output=/scratch/network/users/%u/thun/logs/%x-%A_%a.out
set -euo pipefail
S=/scratch/network/users/$USER
R=/storage/research/wbkolleg_dh_1
CODE=$S/thun/code
SIF=$S/apptainer/vllm-0.29.0.sif
SHARD=${SHARD:-${SLURM_ARRAY_TASK_ID:-0}}
SHARDS=${SHARDS:-1}
ID=olmocr2-7b-german-kurrent-xvi-xix-blb-page-px4m-native-v1
BASE=allenai/olmOCR-2-7B-1025
ADAPTER=$R/Textrecognition_Training/training_folder/trained/$ID
IMAGES=$R/tei/datasets/thun-missiven-images/originals
OUT=$R/tei/thun-readings/ubelix/$ID/shard-$SHARD-of-$SHARDS.jsonl
mkdir -p "$(dirname "$OUT")"
echo "== $ID shard $SHARD/$SHARDS on $(hostname) $(date -Is); images $IMAGES"
apptainer exec --nv \
  --bind /storage/research:/storage/research --bind /scratch:/scratch --bind /rs_scratch:/rs_scratch \
  --env HF_HOME=$R/Textrecognition_Training/hf_hub --env HF_HUB_OFFLINE=1 \
  --env VLLM_NO_USAGE_STATS=1 --env DO_NOT_TRACK=1 \
  "$SIF" python3 "$CODE/ubelix/recognize.py" \
    --images "$IMAGES" --out "$OUT" --base "$BASE" --adapter "$ADAPTER" \
    --model-id "$ID" --prompt-file "$CODE/ubelix/prompts/olmocr2.txt" --shard "$SHARD" --shards "$SHARDS" \
    --max-pixels 4194304 --strip-front-matter --max-num-seqs 32
echo "== done $(date -Is)"
