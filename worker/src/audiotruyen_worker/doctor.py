"""Connectivity checks for `worker doctor`."""

from __future__ import annotations

import shutil
from collections.abc import Callable
from dataclasses import dataclass


@dataclass(frozen=True)
class CheckResult:
    name: str
    ok: bool
    detail: str


def run_check(name: str, fn: Callable[[], str]) -> CheckResult:
    try:
        return CheckResult(name, True, fn())
    except Exception as exc:  # noqa: BLE001 - doctor reports every failure as a result
        return CheckResult(name, False, f"{type(exc).__name__}: {exc}")


def check_supabase(client) -> str:
    client.table("worker_status").select("worker_id").limit(1).execute()
    return "connected, worker_status readable"


def check_r2(storage, worker_id: str) -> str:
    key = f"_doctor/{worker_id}.txt"
    payload = f"audiotruyen doctor probe from {worker_id}".encode()
    storage.put_bytes(key, payload, "text/plain")
    try:
        if storage.get_bytes(key) != payload:
            raise RuntimeError("read-back mismatch")
    finally:
        storage.delete(key)
    return f"put/get/delete ok in bucket {storage.bucket}"


def check_ffmpeg() -> str:
    path = shutil.which("ffmpeg")
    if not path:
        raise FileNotFoundError("ffmpeg is not on PATH (needed from M2)")
    return path
