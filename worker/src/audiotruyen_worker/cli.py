"""Command-line entry point: `uv run worker <command>`."""

from __future__ import annotations

import argparse
import sys

from audiotruyen_worker.config import load_settings
from audiotruyen_worker.doctor import check_ffmpeg, check_r2, check_supabase, run_check


def _doctor() -> int:
    from audiotruyen_worker.db import make_client
    from audiotruyen_worker.storage.r2 import R2Storage

    settings = load_settings()
    client = make_client(settings)
    storage = R2Storage.from_settings(settings)
    results = [
        run_check("supabase", lambda: check_supabase(client)),
        run_check("r2", lambda: check_r2(storage, settings.worker_id)),
        run_check("ffmpeg", check_ffmpeg),
    ]
    for result in results:
        print(f"{'OK  ' if result.ok else 'FAIL'} {result.name:<9} {result.detail}")
    return 0 if all(r.ok for r in results) else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="worker", description="AudioTruyen worker")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("doctor", help="check Supabase, R2 and ffmpeg connectivity")
    args = parser.parse_args(argv)
    if args.command == "doctor":
        return _doctor()
    parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
