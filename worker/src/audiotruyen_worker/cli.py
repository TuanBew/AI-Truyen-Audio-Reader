"""Command-line entry point: `uv run worker <command>`."""

from __future__ import annotations

import argparse
import getpass
import sys
from pathlib import Path

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


def _read_password() -> str:
    first = getpass.getpass("Mật khẩu (ít nhất 12 ký tự): ")
    second = getpass.getpass("Nhập lại mật khẩu: ")
    if first != second:
        raise SystemExit("Hai lần nhập không khớp. Chạy lại lệnh.")
    return first


def _create_user(email: str) -> int:
    from audiotruyen_worker.admin import create_owner
    from audiotruyen_worker.db import make_client

    user_id = create_owner(make_client(load_settings()), email, _read_password())
    print(f"Đã tạo tài khoản {email} ({user_id}).")
    return 0


def _set_password(email: str) -> int:
    from audiotruyen_worker.admin import set_password
    from audiotruyen_worker.db import make_client

    user_id = set_password(make_client(load_settings()), email, _read_password())
    print(f"Đã đổi mật khẩu cho {email} ({user_id}).")
    return 0


LOG_DIR = Path(__file__).resolve().parents[2] / "logs"  # worker/logs (gitignored)


def _run(once: bool) -> int:
    from audiotruyen_worker.app import run_worker
    from audiotruyen_worker.logging_setup import setup_logging

    settings = load_settings()
    setup_logging(
        settings.log_level,
        LOG_DIR,
        [
            settings.supabase_service_role_key.get_secret_value(),
            settings.r2_secret_access_key.get_secret_value(),
        ],
    )
    try:
        run_worker(settings, once=once)
    except KeyboardInterrupt:
        print("Đã dừng worker.")
    return 0


def _enqueue(kind: str, value: str, email: str | None, priority: int) -> int:
    from audiotruyen_worker.admin import enqueue_job, resolve_owner_id
    from audiotruyen_worker.db import make_client

    client = make_client(load_settings())
    job_id = enqueue_job(
        client, resolve_owner_id(client, email), kind.replace("-", "_"), value, priority
    )
    print(f"Đã thêm job {kind} ({job_id}).")
    return 0


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):  # Vietnamese text on any Windows console or pipe
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(prog="worker", description="AudioTruyen worker")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("doctor", help="check Supabase, R2 and ffmpeg connectivity")
    run = sub.add_parser("run", help="run the job loop until Ctrl+C")
    run.add_argument("--once", action="store_true", help="drain the queue once and exit")
    enqueue = sub.add_parser(
        "enqueue", help="add a job for the owner (testing without the web app)"
    )
    enqueue.add_argument("kind", choices=["search", "fetch-novel", "fetch-chapter"])
    enqueue.add_argument("value", help="search query, novel URL or chapter id")
    enqueue.add_argument("--email", help="owner email (default: the only account)")
    enqueue.add_argument("--priority", type=int, choices=[0, 10, 20], default=0)
    create = sub.add_parser("create-user", help="create the owner account (password prompted)")
    create.add_argument("--email", required=True)
    reset = sub.add_parser("set-password", help="set a new password for an existing account")
    reset.add_argument("--email", required=True)
    args = parser.parse_args(argv)
    if args.command == "doctor":
        return _doctor()
    if args.command == "run":
        return _run(args.once)
    if args.command == "enqueue":
        return _enqueue(args.kind, args.value, args.email, args.priority)
    if args.command == "create-user":
        return _create_user(args.email)
    if args.command == "set-password":
        return _set_password(args.email)
    parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
