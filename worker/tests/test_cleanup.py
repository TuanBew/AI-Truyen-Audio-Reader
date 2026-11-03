import pytest

from audiotruyen_worker.audio_store import GcCandidate
from audiotruyen_worker.jobs import cleanup
from audiotruyen_worker.jobs.cleanup import make_cleanup_handler, run_gc
from audiotruyen_worker.jobs.queue import Job
from audiotruyen_worker.jobs.runner import JobCancelled, JobContext, PermanentJobError

N = "aaaaaaaa-0000-0000-0000-000000000001"
C = "cccccccc-0000-0000-0000-000000000001"


class FakeStorage:
    def __init__(self):
        self.deleted: list[list[str]] = []

    def delete_many(self, keys):
        self.deleted.append(list(keys))


class FakeAudioStore:
    def __init__(self, keys=(), candidates=()):
        self.keys = sorted(keys)
        self.marked: set[str] = set()
        self.candidates = list(candidates)
        self.deleted_rows: list[str] = []

    def live_keys(self, prefix, after="", limit=1000):
        live = [k for k in self.keys if k.startswith(prefix) and k > after and k not in self.marked]
        return live[:2]  # small pages to exercise paging

    def mark_deleted(self, keys):
        new = [k for k in keys if k not in self.marked]
        self.marked.update(new)
        return len(new)

    def gc_candidates(self, limit=1000):
        live = [c for c in self.candidates if c.key not in self.marked]
        return live[:2]

    def delete_audio_rows(self, ids):
        self.deleted_rows.extend(ids)


def job(prefix):
    return Job("j", "u", "cleanup_r2", {"prefix": prefix})


def test_cleanup_deletes_every_live_key_under_the_prefix_in_pages():
    keys = [f"audio/{N}/{C}/h/1/seg-{i:04d}.webm" for i in range(5)] + [f"audio/{N}/other"]
    store, storage = FakeAudioStore(keys), FakeStorage()
    result = make_cleanup_handler(store, storage)(job(f"audio/{N}/{C}/"), JobContext(job("")))
    assert result == {"prefix": f"audio/{N}/{C}/", "deleted": 5}
    assert [len(batch) for batch in storage.deleted] == [2, 2, 1]
    assert f"audio/{N}/other" not in store.marked


@pytest.mark.parametrize(
    "prefix", ["audio/", f"audio/{N}", "audio/../x/", f"voices/{N}/../", "other/x/", ""]
)
def test_cleanup_rejects_any_other_prefix(prefix):
    with pytest.raises(PermanentJobError):
        make_cleanup_handler(FakeAudioStore(), FakeStorage())(job(prefix), JobContext(job("")))


def test_cleanup_stops_between_pages_when_cancelled():
    keys = [f"voices/{N}/{i}.wav" for i in range(6)]
    ctx = JobContext(job(""))
    ctx.cancelled.set()
    storage = FakeStorage()
    with pytest.raises(JobCancelled):
        make_cleanup_handler(FakeAudioStore(keys), storage)(job(f"voices/{N}/"), ctx)
    assert len(storage.deleted) == 1


def test_gc_deletes_candidates_and_drops_only_stale_rows():
    candidates = [
        GcCandidate("audio/n/c/h/1/init.webm", "row-a", False),
        GcCandidate("audio/n/c/h/1/seg-0000.webm", "row-a", False),
        GcCandidate("audio/n/d/old/1/init.webm", "row-b", True),
    ]
    store, storage = FakeAudioStore(candidates=candidates), FakeStorage()
    assert run_gc(store, storage) == {"deleted": 3, "stale_rows": 1}
    assert store.deleted_rows == ["row-b"]
    assert run_gc(store, storage) == {"deleted": 0, "stale_rows": 0}


def test_gc_that_stops_early_drops_no_rows(monkeypatch):
    monkeypatch.setattr(cleanup, "MAX_GC_ROUNDS", 3)

    class EndlessStore(FakeAudioStore):
        def __init__(self):
            super().__init__()
            self.calls = 0

        def gc_candidates(self, limit=1000):
            self.calls += 1
            n = self.calls
            return [
                GcCandidate(f"audio/n/d/old/1/seg-{n}-0.webm", f"row-{n}", True),
                GcCandidate(f"audio/n/d/old/1/seg-{n}-1.webm", f"row-{n}", True),
            ]

    store, storage = EndlessStore(), FakeStorage()
    assert run_gc(store, storage) == {"deleted": 6, "stale_rows": 0}
    assert store.calls == 3
    assert store.deleted_rows == []
