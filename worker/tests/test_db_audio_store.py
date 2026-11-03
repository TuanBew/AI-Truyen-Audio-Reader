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


def _defaults(admin_client, user_id):
    rows = admin_client.table("voices").select("*").eq("user_id", user_id).execute().data
    return {
        r["name"]: (
            r["kind"],
            r["is_default_narrator"],
            r["is_default_male"],
            r["is_default_female"],
        )
        for r in rows
    }


def test_init_voices_creates_presets_with_defaults_and_is_a_noop_on_rerun(admin_client, owner):
    audio = AudioStore(admin_client)
    ids = init_voices(audio, owner["id"])
    assert len(set(ids)) == 3
    expected = {
        "Đức Trí": ("preset", True, False, False),
        "Thái Sơn": ("preset", False, True, False),
        "Mỹ Duyên": ("preset", False, False, True),
    }
    assert _defaults(admin_client, owner["id"]) == expected
    before = admin_client.table("voices").select("*").eq("user_id", owner["id"]).execute().data
    assert init_voices(audio, owner["id"]) == ids
    after = admin_client.table("voices").select("*").eq("user_id", owner["id"]).execute().data
    assert sorted(before, key=lambda r: r["id"]) == sorted(after, key=lambda r: r["id"])


def test_init_voices_keeps_a_custom_narrator_and_still_fills_the_other_roles(admin_client, owner):
    me = owner["id"]
    custom = (
        admin_client.table("voices")
        .insert(
            {"user_id": me, "name": "Giọng của tôi", "kind": "clone", "is_default_narrator": True}
        )
        .execute()
        .data[0]["id"]
    )
    audio = AudioStore(admin_client)
    ids = init_voices(audio, me)
    assert audio.default_narrator(me) is None  # the custom clone has no preset_name, still holds it
    flags = _defaults(admin_client, me)
    assert flags["Giọng của tôi"] == ("clone", True, False, False)
    assert flags["Đức Trí"] == ("preset", False, False, False)
    assert flags["Thái Sơn"] == ("preset", False, True, False)
    assert flags["Mỹ Duyên"] == ("preset", False, False, True)
    assert init_voices(audio, me) == ids
    holder = (
        admin_client.table("voices").select("id").eq("user_id", me).eq("is_default_narrator", True)
    )
    assert [r["id"] for r in holder.execute().data] == [custom]


def test_init_voices_never_touches_an_existing_voice_with_a_default_name(admin_client, owner):
    me = owner["id"]
    clone = (
        admin_client.table("voices")
        .insert({"user_id": me, "name": "Đức Trí", "kind": "clone", "gender": "female"})
        .execute()
        .data[0]
    )
    ids = init_voices(AudioStore(admin_client), me)
    assert ids[0] == clone["id"]
    row = admin_client.table("voices").select("*").eq("id", clone["id"]).execute().data[0]
    assert (row["kind"], row["preset_name"], row["gender"]) == ("clone", None, "female")
    assert row["is_default_narrator"] is False  # a clone is never promoted by init-voices
