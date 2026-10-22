"""Worker logging: console + rotating file, with secrets redacted from every line."""

from __future__ import annotations

import logging
from collections.abc import Iterable
from logging.handlers import RotatingFileHandler
from pathlib import Path

# Libraries that log URLs or payloads at DEBUG/INFO. The Realtime client logs its WebSocket URL,
# which carries the service-role key as `apikey`, so these never go below WARNING.
NOISY_LOGGERS = ("realtime", "websockets", "httpx", "httpcore", "hpack", "postgrest", "supabase")
FORMAT = "%(asctime)s %(levelname)s %(name)s: %(message)s"


class RedactingFormatter(logging.Formatter):
    """Replaces known secret values in the fully formatted record (message and traceback)."""

    def __init__(self, fmt: str, secrets: Iterable[str]) -> None:
        super().__init__(fmt)
        self._secrets = sorted({s for s in secrets if s and len(s) >= 8}, key=len, reverse=True)

    def format(self, record: logging.LogRecord) -> str:
        text = super().format(record)
        for secret in self._secrets:
            text = text.replace(secret, "[redacted]")
        return text


def setup_logging(level: str, log_dir: Path, secrets: Iterable[str]) -> None:
    secrets = list(secrets)
    root = logging.getLogger()
    for handler in list(root.handlers):
        root.removeHandler(handler)
        handler.close()
    root.setLevel(level.upper())
    log_dir.mkdir(parents=True, exist_ok=True)
    handlers: list[logging.Handler] = [
        RotatingFileHandler(
            log_dir / "worker.log", maxBytes=5_000_000, backupCount=5, encoding="utf-8"
        ),
        logging.StreamHandler(),
    ]
    for handler in handlers:
        handler.setFormatter(RedactingFormatter(FORMAT, secrets))
        root.addHandler(handler)
    for name in NOISY_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)
