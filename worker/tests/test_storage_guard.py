import pytest

from audiotruyen_worker.storage.guard import IMMUTABLE, GuardedStorage, UploadBlocked


class FakeStorage:
    def __init__(self):
        self.puts: list[tuple] = []

    def put_bytes(self, key, data, content_type, cache_control=None):
        self.puts.append((key, data, content_type, cache_control))
        return len(data)


class FakeClient:
    def __init__(self, verdict):
        self.verdict = verdict
        self.calls: list[tuple] = []

    def rpc(self, name, params):
        self.calls.append((name, params))
        client = self

        class _R:
            def execute(self):
                return type("D", (), {"data": client.verdict})()

        return _R()


def guarded(verdict="ok", enabled=True):
    storage, client = FakeStorage(), FakeClient(verdict)
    return (
        GuardedStorage(storage, client, enabled=enabled, max_bytes=8 * 1024**3, max_puts=800_000),
        storage,
        client,
    )


def test_ok_reserves_then_puts_with_immutable_cache():
    g, storage, client = guarded()
    assert g.put("audio/a/b/h/1/init.webm", b"abc", "audio/webm") == 3
    assert client.calls == [
        (
            "r2_reserve_upload",
            {
                "p_key": "audio/a/b/h/1/init.webm",
                "p_bytes": 3,
                "p_max_bytes": 8 * 1024**3,
                "p_max_puts": 800_000,
            },
        )
    ]
    assert storage.puts == [("audio/a/b/h/1/init.webm", b"abc", "audio/webm", IMMUTABLE)]


@pytest.mark.parametrize(("verdict", "text"), [("bytes_cap", "8 GiB"), ("puts_cap", "800,000")])
def test_caps_refuse_before_any_put(verdict, text):
    g, storage, _ = guarded(verdict)
    with pytest.raises(UploadBlocked, match=text):
        g.put("audio/k", b"x", "audio/webm")
    assert storage.puts == []


def test_kill_switch_refuses_without_touching_the_database():
    g, storage, client = guarded(enabled=False)
    with pytest.raises(UploadBlocked, match="R2_UPLOADS_ENABLED"):
        g.put("audio/k", b"x", "audio/webm")
    assert client.calls == [] and storage.puts == []


def test_unexpected_verdict_is_an_error():
    g, _, _ = guarded("weird")
    with pytest.raises(RuntimeError):
        g.put("audio/k", b"x", "audio/webm")
