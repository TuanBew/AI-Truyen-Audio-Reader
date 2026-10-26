import pytest

from audiotruyen_worker import app
from audiotruyen_worker.config import Settings
from audiotruyen_worker.storage.guard import GuardedStorage
from audiotruyen_worker.tts.fake import FakeTTS


def _settings(**overrides) -> Settings:
    values = {
        "supabase_url": "http://127.0.0.1:1",
        "supabase_service_role_key": "service-role-secret-value-123",
        "r2_account_id": "acct",
        "r2_access_key_id": "key-id",
        "r2_secret_access_key": "r2-secret-value-123",
        "r2_bucket": "bucket",
        "worker_id": "w-test",
        "r2_uploads_enabled": False,
        "r2_max_bytes": 12345,
        "r2_max_puts_per_month": 678,
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)


def _closure(fn) -> dict:
    """The free variables a handler closes over (storage, tts, ...)."""
    cells = (cell.cell_contents for cell in fn.__closure__)
    return dict(zip(fn.__code__.co_freevars, cells, strict=True))


def test_build_runner_wires_the_cost_guard_from_settings(monkeypatch):
    client, r2 = object(), object()
    monkeypatch.setattr(app, "make_client", lambda settings: client)
    monkeypatch.setattr(app.R2Storage, "from_settings", classmethod(lambda cls, settings: r2))
    runner, audio_store, raw_r2 = app.build_runner(_settings(), FakeTTS())

    assert set(runner.handlers) == {
        "search",
        "fetch_novel",
        "fetch_chapter",
        "synthesize",
        "cleanup_r2",
    }
    guarded = _closure(runner.handlers["synthesize"])["storage"]
    assert isinstance(guarded, GuardedStorage)
    assert (guarded.enabled, guarded.max_bytes, guarded.max_puts) == (False, 12345, 678)
    assert guarded._storage is r2 and guarded._client is client
    # Deletes and GC take the raw R2Storage: the guard covers uploads only.
    assert raw_r2 is r2
    assert _closure(runner.handlers["cleanup_r2"])["storage"] is r2
    assert runner.device() == "fake"


class _FakeRunner:
    def __init__(self, events):
        self.events = events
        self.wake = object()

    def beat(self):
        self.events.append("beat")

    def run_once(self):
        self.events.append("run_once")
        return False

    def run_forever(self, stop):
        self.events.append("run_forever")


@pytest.fixture
def wiring(monkeypatch):
    events: list = []
    runner = _FakeRunner(events)
    monkeypatch.setattr(app, "make_tts", lambda settings, *, fake: FakeTTS())
    monkeypatch.setattr(app, "build_runner", lambda settings, tts: (runner, "audio", "r2"))
    monkeypatch.setattr(app, "preload", lambda tts: events.append("preload"))
    monkeypatch.setattr(app, "make_client", lambda settings: events.append("client") or object())

    def run_gc(audio_store, storage):
        events.append(("gc", audio_store, storage))
        raise RuntimeError("gc exploded")

    monkeypatch.setattr(app, "run_gc", run_gc)

    class _Thread:
        def __init__(self, name):
            self.name = name

        def __call__(self, *args, **kwargs):
            self.args = args
            return self

        def start(self):
            events.append(self.name)

    monkeypatch.setattr(app, "Heartbeat", _Thread("heartbeat"))
    monkeypatch.setattr(app, "RealtimeWake", _Thread("wake"))
    monkeypatch.setattr(app, "JobQueue", lambda client, worker_id: object())
    return events


def test_run_worker_once_survives_a_gc_failure_and_skips_background_threads(wiring):
    app.run_worker(_settings(), once=True, fake_tts=True)
    assert wiring == [("gc", "audio", "r2"), "beat", "run_once"]  # no preload/client/threads


def test_run_worker_preloads_before_gc_and_gc_runs_before_the_job_loop(wiring):
    app.run_worker(_settings(), fake_tts=True)  # the failing GC must not stop the worker
    assert wiring == [
        "preload",
        ("gc", "audio", "r2"),
        "client",
        "heartbeat",
        "wake",
        "run_forever",
    ]
