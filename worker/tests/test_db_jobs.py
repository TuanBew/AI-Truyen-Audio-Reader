import pytest
from postgrest.exceptions import APIError

from audiotruyen_worker.jobs.queue import JobQueue

pytestmark = pytest.mark.db


def test_queue_roundtrip_and_fencing(admin_client, owner):
    queue = JobQueue(admin_client, "w-db-test")
    other = JobQueue(admin_client, "w-other")
    admin_client.table("jobs").insert(
        {"user_id": owner["id"], "type": "search", "payload": {"query": "a"}}
    ).execute()
    job = queue.claim(["search"])
    assert job is not None and job.payload == {"query": "a"} and job.attempts == 1
    assert queue.heartbeat("0.2.0", "cpu", job.id) is True
    assert other.finish(job.id, "done") is False
    try:
        assert queue.fail(job.id, "tạm thời", True) == "queued"
        assert queue.fail(job.id, "tạm thời", True) is None
    finally:  # worker_status has no owner column, so user deletion does not clean it up
        admin_client.table("worker_status").delete().eq("worker_id", "w-db-test").execute()


def test_web_enqueue_is_guarded(owner):
    from supabase import create_client

    from tests.conftest import ANON, URL

    client = create_client(URL, ANON)
    client.auth.sign_in_with_password({"email": owner["email"], "password": owner["password"]})
    client.table("jobs").insert(
        {"user_id": owner["id"], "type": "search", "payload": {"query": "a"}}
    ).execute()
    with pytest.raises(APIError):
        client.table("jobs").insert(
            {"user_id": owner["id"], "type": "search", "status": "running"}
        ).execute()
