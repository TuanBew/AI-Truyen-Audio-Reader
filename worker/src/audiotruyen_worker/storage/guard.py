"""Cost guard for every R2 upload (spec 7.3.1): kill switch, storage cap and monthly PUT cap.
Each upload is reserved in Postgres (`r2_reserve_upload`) before the PUT is sent, so the
`r2_objects` ledger never misses an object and concurrent uploads cannot overshoot the caps."""

from __future__ import annotations

IMMUTABLE = "public, max-age=31536000, immutable"


class UploadBlocked(Exception):
    """An upload was refused by the kill switch or a cap. The message is for the owner."""


class GuardedStorage:
    def __init__(self, storage, client, *, enabled: bool, max_bytes: int, max_puts: int) -> None:
        self._storage = storage
        self._client = client
        self.enabled = enabled
        self.max_bytes = max_bytes
        self.max_puts = max_puts

    def check_enabled(self) -> None:
        if not self.enabled:
            raise UploadBlocked(
                "Đang tắt upload lên R2 (R2_UPLOADS_ENABLED=false trong worker/.env). "
                "Bật lại rồi bấm Thử lại."
            )

    def put(self, key: str, data: bytes, content_type: str) -> int:
        self.check_enabled()
        verdict = (
            self._client.rpc(
                "r2_reserve_upload",
                {
                    "p_key": key,
                    "p_bytes": len(data),
                    "p_max_bytes": self.max_bytes,
                    "p_max_puts": self.max_puts,
                },
            )
            .execute()
            .data
        )
        if verdict == "bytes_cap":
            gib = self.max_bytes / 1024**3
            raise UploadBlocked(
                f"Kho audio trên R2 đã chạm giới hạn {gib:g} GiB. "
                "Xóa bớt truyện hoặc tăng R2_MAX_BYTES rồi bấm Thử lại."
            )
        if verdict == "puts_cap":
            raise UploadBlocked(
                f"Đã chạm giới hạn {self.max_puts:,} lần ghi R2 trong tháng này. "
                "Chờ sang tháng hoặc tăng R2_MAX_PUTS_PER_MONTH."
            )
        if verdict != "ok":
            raise RuntimeError(f"unexpected r2_reserve_upload result {verdict!r}")
        return self._storage.put_bytes(key, data, content_type, cache_control=IMMUTABLE)
