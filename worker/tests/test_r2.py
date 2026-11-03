import boto3
import pytest
from moto import mock_aws

from audiotruyen_worker.storage.r2 import R2Storage


@pytest.fixture
def storage():
    with mock_aws():
        client = boto3.client("s3", region_name="us-east-1")
        client.create_bucket(Bucket="audiotruyen")
        yield R2Storage(client, "audiotruyen")


def test_put_then_get_roundtrip(storage):
    storage.put_bytes("a/b.txt", b"xin chao", "text/plain")
    assert storage.get_bytes("a/b.txt") == b"xin chao"


def test_exists_reflects_object_presence(storage):
    assert storage.exists("missing.txt") is False
    storage.put_bytes("present.txt", b"1", "text/plain")
    assert storage.exists("present.txt") is True


def test_delete_removes_object(storage):
    storage.put_bytes("gone.txt", b"1", "text/plain")
    storage.delete("gone.txt")
    assert storage.exists("gone.txt") is False


def test_put_sets_content_type(storage):
    storage.put_bytes("seg.webm", b"\x1a\x45\xdf\xa3", "audio/webm")
    head = storage.client.head_object(Bucket="audiotruyen", Key="seg.webm")
    assert head["ContentType"] == "audio/webm"


def test_put_bytes_returns_size_and_sets_cache_control(storage):
    assert (
        storage.put_bytes("a.webm", b"12345", "audio/webm", cache_control="public, max-age=60") == 5
    )
    head = storage.client.head_object(Bucket="audiotruyen", Key="a.webm")
    assert head["CacheControl"] == "public, max-age=60"


def test_delete_many_removes_keys_and_ignores_missing(storage):
    for key in ("k1", "k2"):
        storage.put_bytes(key, b"1", "text/plain")
    storage.delete_many(["k1", "k2", "missing"])
    assert not storage.exists("k1") and not storage.exists("k2")
    storage.delete_many([])
    with pytest.raises(ValueError):
        storage.delete_many([f"k{i}" for i in range(1001)])


def test_client_has_connect_and_read_timeouts():
    from audiotruyen_worker.config import Settings

    settings = Settings(
        _env_file=None,
        supabase_url="http://127.0.0.1:1",
        supabase_service_role_key="service-role-secret-value-123",
        r2_account_id="acct",
        r2_access_key_id="key-id",
        r2_secret_access_key="r2-secret-value-123",
        r2_bucket="bucket",
    )
    config = R2Storage.from_settings(settings).client.meta.config
    assert (config.connect_timeout, config.read_timeout) == (10, 60)
    # max_attempts=5 is normalized to 6 total attempts (1 call + 5 retries)
    assert config.retries == {"mode": "standard", "total_max_attempts": 6}
