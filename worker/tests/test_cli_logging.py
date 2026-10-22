import logging

import pytest

from audiotruyen_worker import cli
from audiotruyen_worker.admin import enqueue_job, resolve_owner_id
from audiotruyen_worker.logging_setup import RedactingFormatter, setup_logging

SECRET = "service-role-secret-value-123"


def test_formatter_redacts_messages_and_tracebacks():
    formatter = RedactingFormatter("%(message)s", [SECRET, "short"])
    try:
        raise RuntimeError(f"connect wss://x/realtime/v1/websocket?apikey={SECRET}")
    except RuntimeError:
        record = logging.LogRecord("t", logging.ERROR, __file__, 1, "key=%s", (SECRET,), None)
        import sys

        record.exc_info = sys.exc_info()
    text = formatter.format(record)
    assert SECRET not in text
    assert text.count("[redacted]") == 2
    assert "short" not in formatter._secrets  # secrets under 8 chars are ignored


def test_setup_logging_writes_file_and_silences_noisy_loggers(tmp_path):
    setup_logging("DEBUG", tmp_path, [SECRET])
    logging.getLogger("audiotruyen_worker.test").info("xin chào %s", SECRET)
    for handler in logging.getLogger().handlers:
        handler.flush()
    content = (tmp_path / "worker.log").read_text(encoding="utf-8")
    assert "xin chào [redacted]" in content and SECRET not in content
    assert logging.getLogger("realtime").getEffectiveLevel() == logging.WARNING
    assert logging.getLogger("httpx").getEffectiveLevel() == logging.WARNING
    setup_logging("INFO", tmp_path, [])  # idempotent: replaces handlers instead of stacking
    assert len(logging.getLogger().handlers) == 2
    for handler in logging.getLogger().handlers:
        handler.close()
    logging.getLogger().handlers.clear()


class _User:
    def __init__(self, id_, email):
        self.id, self.email = id_, email


class _Admin:
    def __init__(self, users):
        self.users = users

    def list_users(self, page, per_page):
        start = (page - 1) * per_page
        return self.users[start : start + per_page]


class _Client:
    def __init__(self, users):
        self.auth = type("A", (), {"admin": _Admin(users)})()
        self.inserted = []

    def table(self, name):
        client = self

        class _T:
            def insert(self, row):
                client.inserted.append((name, row))
                return self

            def execute(self):
                return type("R", (), {"data": [{"id": "job-1"}]})()

        return _T()


def test_resolve_owner_id_single_account_or_email():
    assert resolve_owner_id(_Client([_User("u1", "a@x")]), None) == "u1"
    two = _Client([_User("u1", "a@x"), _User("u2", "b@x")])
    with pytest.raises(LookupError):
        resolve_owner_id(two, None)
    assert resolve_owner_id(two, "B@x") == "u2"


def test_enqueue_job_builds_the_payload():
    client = _Client([])
    assert enqueue_job(client, "u1", "fetch_novel", "https://truyenfull.live/a/") == "job-1"
    assert client.inserted == [
        (
            "jobs",
            {
                "user_id": "u1",
                "type": "fetch_novel",
                "payload": {"url": "https://truyenfull.live/a/"},
                "priority": 0,
            },
        )
    ]
    with pytest.raises(ValueError):
        enqueue_job(client, "u1", "synthesize", "x")


def test_cli_dispatches_run_and_enqueue(monkeypatch):
    calls = []
    monkeypatch.setattr(cli, "_run", lambda once: calls.append(("run", once)) or 0)
    monkeypatch.setattr(cli, "_enqueue", lambda *a: calls.append(("enqueue", *a)) or 0)
    assert cli.main(["run", "--once"]) == 0
    assert cli.main(["enqueue", "fetch-novel", "https://truyenfull.live/a/"]) == 0
    assert calls == [
        ("run", True),
        ("enqueue", "fetch-novel", "https://truyenfull.live/a/", None, 0),
    ]


def test_log_dir_is_worker_logs():
    assert (cli.LOG_DIR.parent.name, cli.LOG_DIR.name) == ("worker", "logs")


def _patch_enqueue(monkeypatch, *, resolve=None, enqueue=None):
    from audiotruyen_worker import admin, db

    calls = []
    monkeypatch.setattr(cli, "load_settings", lambda: calls.append("settings") or object())
    monkeypatch.setattr(db, "make_client", lambda settings: calls.append("client") or object())
    monkeypatch.setattr(admin, "resolve_owner_id", resolve or (lambda client, email: "u1"))
    monkeypatch.setattr(
        admin, "enqueue_job", enqueue or (lambda client, user_id, kind, value, priority: "job-1")
    )
    return calls


def _raiser(exc):
    def raise_(*args):
        raise exc

    return raise_


def test_enqueue_reports_success(monkeypatch, capsys):
    _patch_enqueue(monkeypatch)
    assert cli.main(["enqueue", "search", "đấu phá"]) == 0
    assert "job-1" in capsys.readouterr().out


def test_enqueue_without_a_single_account_asks_for_email(monkeypatch, capsys):
    _patch_enqueue(monkeypatch, resolve=_raiser(LookupError("expected exactly one account")))
    assert cli.main(["enqueue", "search", "đấu phá"]) == 1
    err = capsys.readouterr().err
    assert "Không tìm thấy tài khoản. Dùng --email để chọn tài khoản." in err
    assert "expected exactly one" not in err


@pytest.mark.parametrize(
    "exc",
    [
        ValueError("cannot enqueue job type 'zzleak'"),
        __import__("postgrest.exceptions", fromlist=["APIError"]).APIError(
            {"message": "jobs: queue limit zzleak", "code": "54000"}
        ),
    ],
)
def test_enqueue_rejected_job_prints_vietnamese_without_raw_text(monkeypatch, capsys, exc):
    _patch_enqueue(monkeypatch, enqueue=_raiser(exc))
    assert cli.main(["enqueue", "fetch-chapter", "c1"]) == 1
    err = capsys.readouterr().err
    assert "Không thêm được job: dữ liệu không hợp lệ." in err
    assert "zzleak" not in err


@pytest.mark.parametrize("value", ["", "   "])
def test_enqueue_rejects_a_blank_value_before_any_network_call(monkeypatch, capsys, value):
    calls = _patch_enqueue(monkeypatch)
    assert cli.main(["enqueue", "search", value]) == 1
    assert "Giá trị không được để trống." in capsys.readouterr().err
    assert calls == []
