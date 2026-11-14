"""Add one run's readings by hand: a shortcut to collect_series.py.

    python3 scripts/collect_readings.py <run dir> [<run dir> ...]
    python3 scripts/collect_readings.py <file.jsonl or glob> --reader <id>

A run dir is what the gateway batch runner or the external (Gemini) reader
wrote on tei, ``.../vlm_test/<run>/<model>/<page key>.json``; a model folder of
it works too. A jsonl holds ``{"key": <page key>, "text": ...}`` per line
(e.g. a UBELIX job's ``<model>/shard-*.jsonl``). Readings are merged into
``readings/<model>.jsonl`` exactly as the pipeline does (docs/PIPELINE.md):
pages are added or updated, never removed. Standard library only.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import collect_series  # noqa: E402

if __name__ == "__main__":
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        sys.exit(__doc__)
    if "--reader" in args:
        i = args.index("--reader")
        reader, paths = args[i + 1], args[:i] + args[i + 2:]
        sys.argv = [sys.argv[0], *[x for p in paths for x in ("--jsonl", p) if not p.startswith("--")], "--reader", reader,
                    *[p for p in paths if p == "--dry-run"]]
    else:
        sys.argv = [sys.argv[0], *[x for p in args if p != "--dry-run" for x in ("--run", p)], *[p for p in args if p == "--dry-run"]]
    collect_series.main()
