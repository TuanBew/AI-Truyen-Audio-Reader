"""Cloudflare R2 access through its S3-compatible API."""

from __future__ import annotations

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from audiotruyen_worker.config import Settings


class R2Storage:
    def __init__(self, client, bucket: str):
        self.client = client
        self.bucket = bucket

    @classmethod
    def from_settings(cls, settings: Settings) -> R2Storage:
        client = boto3.client(
            "s3",
            endpoint_url=settings.r2_endpoint,
            aws_access_key_id=settings.r2_access_key_id,
            aws_secret_access_key=settings.r2_secret_access_key.get_secret_value(),
            region_name="auto",
            config=Config(
                signature_version="s3v4", retries={"max_attempts": 5, "mode": "standard"}
            ),
        )
        return cls(client, settings.r2_bucket)

    def put_bytes(
        self, key: str, data: bytes, content_type: str, cache_control: str | None = None
    ) -> int:
        """Upload one object; returns its size in bytes."""
        extra = {"CacheControl": cache_control} if cache_control else {}
        self.client.put_object(
            Bucket=self.bucket, Key=key, Body=data, ContentType=content_type, **extra
        )
        return len(data)

    def get_bytes(self, key: str) -> bytes:
        return self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()

    def exists(self, key: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=key)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"404", "NoSuchKey", "NotFound"}:
                return False
            raise
        return True

    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=key)

    def delete_many(self, keys: list[str]) -> None:
        """Delete up to 1000 keys in one request; missing keys are not an error."""
        if not keys:
            return
        if len(keys) > 1000:
            raise ValueError("delete_many takes at most 1000 keys")
        response = self.client.delete_objects(
            Bucket=self.bucket,
            Delete={"Objects": [{"Key": k} for k in keys], "Quiet": True},
        )
        errors = response.get("Errors") or []
        if errors:
            first = errors[0]
            raise RuntimeError(f"R2 delete failed for {len(errors)} keys ({first.get('Code')})")
