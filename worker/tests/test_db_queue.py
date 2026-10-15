import threading

import pytest
from postgrest.exceptions import APIError

pytestmark = pytest.mark.db


def _novel_and_chapter(admin_client, owner_id):
    novel = (
        admin_client.table("novels")
        .insert(
            {
                "user_id": owner_id,
                "source": "truyenfull",
                "source_novel_id": "t1",
                "url": "u",
                "title": "T",
            }
        )
        .execute()
        .data[0]
    )
    chapter = (
        admin_client.table("chapters")
        .insert(
            {"user_id": owner_id, "novel_id": novel["id"], "index": 1, "title": "C1", "url": "u1"}
        )
        .execute()
        .data[0]
    )
    return novel, chapter


def test_claim_job_hands_each_job_to_exactly_one_worker(admin_client, owner):
    from supabase import create_client

    from tests.conftest import SERVICE, URL

    rows = [
        {"user_id": owner["id"], "type": "fetch_chapter", "payload": {"n": i}} for i in range(24)
    ]
    mine = {r["id"] for r in admin_client.table("jobs").insert(rows).execute().data}

    claimed: list[str] = []
    lock = threading.Lock()

    def run(worker_id: str) -> None:
        client = create_client(URL, SERVICE)
        while True:
            data = (
                client.rpc("claim_job", {"p_worker_id": worker_id, "p_lease_seconds": 300})
                .execute()
                .data
            )
            if not data:
                return
            with lock:
                claimed.extend(row["id"] for row in data)

    threads = [threading.Thread(target=run, args=(f"w{i}",)) for i in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)

    assert len(claimed) == len(set(claimed)), "a job was claimed twice"
    assert mine <= set(claimed), "some jobs were never claimed"


def test_begin_chapter_audio_attempt_fencing(admin_client, owner):
    _, chapter = _novel_and_chapter(admin_client, owner["id"])
    args = {"p_chapter_id": chapter["id"], "p_voice_hash": "vh1"}

    first = admin_client.rpc("begin_chapter_audio", args).execute().data[0]
    assert (first["attempt"], first["status"]) == (1, "queued")

    fenced = (
        admin_client.table("chapter_audio")
        .update({"init_key": "a1/init.webm", "status": "partial"})
        .eq("id", first["id"])
        .eq("attempt", 1)
        .execute()
        .data
    )
    assert len(fenced) == 1

    second = admin_client.rpc("begin_chapter_audio", args).execute().data[0]
    assert second["attempt"] == 2

    stale = (
        admin_client.table("chapter_audio")
        .update({"init_key": "stale"})
        .eq("id", first["id"])
        .eq("attempt", 1)
        .execute()
        .data
    )
    assert stale == [], "a stale attempt must not be able to write"


def test_authenticated_user_cannot_claim_jobs(owner):
    from supabase import create_client

    from tests.conftest import ANON, URL

    client = create_client(URL, ANON)
    client.auth.sign_in_with_password({"email": owner["email"], "password": owner["password"]})
    with pytest.raises(APIError):
        client.rpc("claim_job", {"p_worker_id": "x", "p_lease_seconds": 300}).execute()
