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
