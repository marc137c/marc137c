"""CLI: `python -m leadscout run [--loop --every 24h]`."""
from __future__ import annotations

import argparse
import logging
import re
import sys
import time

from .config import load_config
from .pipeline import run_once


def parse_interval(text: str) -> int:
    m = re.fullmatch(r"(\d+)\s*([smhd])", text.strip().lower())
    if not m:
        raise argparse.ArgumentTypeError("use e.g. 30m, 6h, 1d")
    return int(m[1]) * {"s": 1, "m": 60, "h": 3600, "d": 86400}[m[2]]


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="leadscout", description="Find Østfold businesses without a website.")
    sub = p.add_subparsers(dest="cmd", required=True)
    run = sub.add_parser("run", help="scout for new leads")
    run.add_argument("-c", "--config", default="config.toml")
    run.add_argument("--loop", action="store_true", help="keep running on a schedule")
    run.add_argument("--every", type=parse_interval, default=parse_interval("24h"))
    args = p.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    cfg = load_config(args.config)
    while True:
        try:
            run_once(cfg)
        except Exception:
            logging.exception("Run failed")
            if not args.loop:
                return 1
        if not args.loop:
            return 0
        logging.info("Sleeping %ss until next run.", args.every)
        time.sleep(args.every)


if __name__ == "__main__":
    sys.exit(main())
