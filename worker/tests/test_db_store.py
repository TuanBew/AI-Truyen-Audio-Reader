import pytest

from audiotruyen_worker.sources.base import ChapterRef, NovelInfo
from audiotruyen_worker.store import Store

pytestmark = pytest.mark.db


INFO = NovelInfo(
    "45719", "https://truyenfull.live/a/", "a", "Truyện A", "Tác giả", None, "Giới thiệu", "ongoing"
)


def _refs(indexes, suffix=""):
    return [
        ChapterRef(i, f"Chương {i}{suffix}", f"https://truyenfull.live/a/chuong-{i}/")
        for i in indexes
    ]


def test_store_upserts_are_idempotent_and_never_delete(admin_client, owner):
    store = Store(admin_client)
    novel_id = store.upsert_novel(owner["id"], INFO)
    assert store.upsert_novel(owner["id"], INFO) == novel_id
    store.upsert_chapters(owner["id"], novel_id, _refs(range(1, 4)))
    first = store.chapter(
        admin_client.table("chapters")
        .select("id")
        .eq("novel_id", novel_id)
        .eq("index", 1)
        .execute()
        .data[0]["id"],
        owner["id"],
    )
    store.save_chapter_text(first.id, "nội dung", "h1")
    # A re-read TOC with a renamed chapter and fewer entries: titles refresh, text and rows stay.
    store.upsert_chapters(owner["id"], novel_id, _refs([1], " (sửa)"))
    rows = (
        admin_client.table("chapters")
        .select("index,title,text")
        .eq("novel_id", novel_id)
        .order("index")
        .execute()
        .data
    )
    assert [r["index"] for r in rows] == [1, 2, 3]
    assert rows[0]["title"] == "Chương 1 (sửa)" and rows[0]["text"] == "nội dung"
    store.finish_toc(novel_id, 3)
    novel = (
        admin_client.table("novels")
        .select("chapter_count,last_checked_at")
        .eq("id", novel_id)
        .execute()
        .data[0]
    )
    assert novel["chapter_count"] == 3 and novel["last_checked_at"] is not None


def test_store_chapter_is_scoped_to_the_owner(admin_client, owner):
    store = Store(admin_client)
    novel_id = store.upsert_novel(owner["id"], INFO)
    store.upsert_chapters(owner["id"], novel_id, _refs([1]))
    chapter_id = (
        admin_client.table("chapters").select("id").eq("novel_id", novel_id).execute().data[0]["id"]
    )
    assert store.chapter(chapter_id, owner["id"]) is not None
    assert store.chapter(chapter_id, "22222222-2222-2222-2222-222222222222") is None


def test_store_analysis_roundtrip(admin_client, owner):
    store = Store(admin_client)
    novel_id = store.upsert_novel(owner["id"], INFO)
    store.upsert_chapters(owner["id"], novel_id, _refs([1]))
    chapter_id = (
        admin_client.table("chapters").select("id").eq("novel_id", novel_id).execute().data[0]["id"]
    )
    assert store.has_analysis(chapter_id, "h", "heuristic", 1) is False
    store.save_analysis(owner["id"], chapter_id, "h", "heuristic", 1, [{"i": 0}])
    store.save_analysis(owner["id"], chapter_id, "h", "heuristic", 1, [{"i": 0}])  # idempotent
    assert store.has_analysis(chapter_id, "h", "heuristic", 1) is True
    admin_client.table("characters").insert(
        {
            "user_id": owner["id"],
            "novel_id": novel_id,
            "name": "Lâm Phong",
            "gender": "male",
            "aliases": ["Phong ca"],
        }
    ).execute()
    (character,) = store.roster(novel_id)
    assert (character.name, character.gender, character.aliases) == (
        "Lâm Phong",
        "male",
        ("Phong ca",),
    )
