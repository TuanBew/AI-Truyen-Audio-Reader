import boto3
import pytest
from moto import mock_aws

from audiotruyen_worker.admin import enqueue_synthesize, init_voices
from audiotruyen_worker.audio.baselines import Baselines
from audiotruyen_worker.audio_store import AudioStore
from audiotruyen_worker.jobs.cleanup import make_cleanup_handler
from audiotruyen_worker.jobs.handlers import ChapterPreparer
from audiotruyen_worker.jobs.queue import JobQueue
from audiotruyen_worker.jobs.runner import Runner
from audiotruyen_worker.jobs.synthesize import make_synthesize_handler
from audiotruyen_worker.sources.base import ChapterRef, NovelInfo
from audiotruyen_worker.speakers.heuristic import HeuristicStrategy
from audiotruyen_worker.storage.guard import GuardedStorage
from audiotruyen_worker.storage.r2 import R2Storage
from audiotruyen_worker.store import Store
from audiotruyen_worker.tts.fake import FakeTTS

pytestmark = pytest.mark.db

TEXT = "“Ngươi dám!” Lâm Phong quát.\nTrời tối dần. " + "Gió thổi qua rừng già. " * 40


@pytest.fixture
def r2():
    with mock_aws():
        client = boto3.client("s3", region_name="us-east-1")
        client.create_bucket(Bucket="audiotruyen")
        yield R2Storage(client, "audiotruyen")


def _novel_with_chapter(admin_client, owner_id, text=TEXT):
    store = Store(admin_client)
    info = NovelInfo(
        f"m2b-{owner_id[:8]}", "https://truyenfull.live/a/", "a", "A", None, None, None, None
    )
    novel_id = store.upsert_novel(owner_id, info)
    store.upsert_chapters(
        owner_id, novel_id, [ChapterRef(1, "Chương 1", "https://truyenfull.live/a/chuong-1/")]
    )
    chapter_id = (
        admin_client.table("chapters").select("id").eq("novel_id", novel_id).execute().data[0]["id"]
    )
    if text is not None:
        store.save_chapter_text(chapter_id, text, "t-" + chapter_id[:8])
    return store, novel_id, chapter_id


def test_synthesize_job_end_to_end_then_cleanup_on_delete(admin_client, owner, r2):
    store, novel_id, chapter_id = _novel_with_chapter(admin_client, owner["id"])
    audio = AudioStore(admin_client)
    init_voices(audio, owner["id"])
    tts = FakeTTS()
    guarded = GuardedStorage(r2, admin_client, enabled=True, max_bytes=8 * 1024**3, max_puts=10**9)
    handlers = {
        "synthesize": make_synthesize_handler(
            preparer=ChapterPreparer(None, store, [HeuristicStrategy()]),
            store=store, audio_store=audio, storage=guarded, tts=tts, baselines=Baselines(tts),
        ),
        "cleanup_r2": make_cleanup_handler(audio, r2),
    }  # fmt: skip
    runner = Runner(JobQueue(admin_client, "w-m2b"), handlers, version="t", device="fake")
    enqueue_synthesize(admin_client, owner["id"], chapter_id)
    assert runner.run_once() is True
    row = (
        admin_client.table("chapter_audio")
        .select("*")
        .eq("chapter_id", chapter_id)
        .execute()
        .data[0]
    )
    assert (row["status"], row["provider"], row["attempt"]) == ("ready", "fake", 1)
    keys = [row["init_key"], *[c["key"] for c in row["chunks"]], row["full_key"]]
    assert all(r2.exists(k) for k in keys)
    prefix = f"audio/{novel_id}/{chapter_id}/"
    assert sorted(audio.live_keys(prefix)) == sorted(keys)
    assert row["segments"] and row["segments"][-1]["end_ms"] <= row["duration_ms"]
    job = (
        admin_client.table("jobs")
        .select("status")
        .eq("type", "synthesize")
        .eq("user_id", owner["id"])
        .execute()
        .data
    )
    assert [j["status"] for j in job] == ["done"]

    admin_client.table("chapters").delete().eq("id", chapter_id).execute()
    assert runner.run_once() is True  # the cleanup_r2 job the delete trigger enqueued
    assert audio.live_keys(prefix) == []
    assert not any(r2.exists(k) for k in keys)
    admin_client.table("worker_status").delete().eq("worker_id", "w-m2b").execute()


def test_outdated_voice_hash_job_is_cancelled(admin_client, owner, r2):
    store, novel_id, chapter_id = _novel_with_chapter(admin_client, owner["id"])
    audio = AudioStore(admin_client)
    init_voices(audio, owner["id"])
    tts = FakeTTS()
    handlers = {
        "synthesize": make_synthesize_handler(
            preparer=ChapterPreparer(None, store, [HeuristicStrategy()]), store=store,
            audio_store=audio, storage=GuardedStorage(r2, admin_client, enabled=True,
            max_bytes=8 * 1024**3, max_puts=10**9), tts=tts, baselines=Baselines(tts),
        )
    }  # fmt: skip
    admin_client.table("jobs").insert({
        "user_id": owner["id"], "type": "synthesize",
        "payload": {"chapter_id": chapter_id, "voice_hash": "0000000000000000"},
    }).execute()  # fmt: skip
    Runner(JobQueue(admin_client, "w-m2b-2"), handlers, version="t", device="fake").run_once()
    (row,) = (
        admin_client.table("jobs")
        .select("status,result")
        .eq("type", "synthesize")
        .eq("user_id", owner["id"])
        .execute()
        .data
    )
    assert row["status"] == "cancelled" and "đã đổi" in row["result"]["reason"]
    assert (
        admin_client.table("chapter_audio").select("id").eq("chapter_id", chapter_id).execute().data
        == []
    )
