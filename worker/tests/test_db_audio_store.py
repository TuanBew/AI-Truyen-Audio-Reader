import boto3
import pytest
from moto import mock_aws

from audiotruyen_worker.admin import init_voices
from audiotruyen_worker.audio_store import AudioStore
from audiotruyen_worker.sources.base import ChapterRef, NovelInfo
from audiotruyen_worker.storage.guard import GuardedStorage, UploadBlocked
from audiotruyen_worker.storage.r2 import R2Storage
from audiotruyen_worker.store import Store
from audiotruyen_worker.text.normalize import LexiconRule

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


def test_guarded_upload_enforces_the_caps_through_postgres(admin_client, owner, r2):
    audio = AudioStore(admin_client)
    usage = audio.usage()
    prefix = f"audio/{owner['id']}/x/h/1/"
    guarded = GuardedStorage(
        r2, admin_client, enabled=True,
        max_bytes=usage["live_bytes"] + 10, max_puts=usage["month_puts"] + 3,
    )  # fmt: skip
    assert guarded.put(prefix + "a.webm", b"12345678", "audio/webm") == 8
    with pytest.raises(UploadBlocked, match="GiB"):
        guarded.put(prefix + "b.webm", b"12345", "audio/webm")
    assert not r2.exists(prefix + "b.webm")
    assert guarded.put(prefix + "a.webm", b"12345678", "audio/webm") == 8  # retry, same bytes
    assert audio.usage()["live_bytes"] == usage["live_bytes"] + 8
    assert guarded.put(prefix + "c.webm", b"1", "audio/webm") == 1
    with pytest.raises(UploadBlocked, match="lần ghi"):
        guarded.put(prefix + "d.webm", b"1", "audio/webm")
    assert audio.live_keys(prefix) == [prefix + "a.webm", prefix + "c.webm"]
    assert audio.mark_deleted([prefix + "a.webm", prefix + "c.webm"]) == 2
    assert audio.live_keys(prefix) == []


def test_audio_store_voices_lexicon_hash_and_fencing(admin_client, owner):
    store, novel_id, chapter_id = _novel_with_chapter(admin_client, owner["id"])
    audio = AudioStore(admin_client)
    assert audio.default_narrator(owner["id"]) is None
    ids = init_voices(audio, owner["id"])
    assert init_voices(audio, owner["id"]) == ids  # idempotent
    narrator = audio.default_narrator(owner["id"])
    assert (narrator.voice_id, narrator.preset) == (ids[0], "Đức Trí")
    first_hash = audio.voice_hash(novel_id)
    me = owner["id"]
    admin_client.table("lexicon").insert(
        [
            {"user_id": me, "pattern": "B", "replacement": "b", "position": 2},
            {"user_id": me, "pattern": "A", "replacement": "a", "position": 1},
            {
                "user_id": me,
                "novel_id": novel_id,
                "pattern": "N",
                "replacement": "n",
                "position": 0,
            },
        ]
    ).execute()
    assert audio.lexicon(owner["id"], novel_id) == [
        LexiconRule("A", "a"),
        LexiconRule("B", "b"),
        LexiconRule("N", "n"),
    ]
    assert audio.voice_hash(novel_id) != first_hash
    row = audio.begin(chapter_id, "vh")
    assert (row.attempt, row.status) == (1, "queued")
    assert audio.update(row, {"status": "partial"}) is True
    newer = audio.begin(chapter_id, "vh")
    assert newer.attempt == 2
    assert audio.update(row, {"status": "partial"}) is False  # fenced out
