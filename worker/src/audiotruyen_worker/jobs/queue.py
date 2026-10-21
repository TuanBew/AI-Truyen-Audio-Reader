"""Job queue RPC wrappers (service role). Every write is fenced by (job id, worker id, running)."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class Job:
    id: str
    user_id: str
    type: str
    payload: dict[str, Any] = field(default_factory=dict)
    priority: int = 10
    attempts: int = 1
    max_attempts: int = 3

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> Job:
        return cls(
            id=row["id"],
            user_id=row["user_id"],
            type=row["type"],
            payload=row.get("payload") or {},
            priority=row["priority"],
            attempts=row["attempts"],
            max_attempts=row["max_attempts"],
        )


class JobQueue:
    def __init__(self, client, worker_id: str, lease_seconds: int = 300) -> None:
        self._client = client
        self.worker_id = worker_id
        self.lease_seconds = lease_seconds

    def _rpc(self, name: str, params: dict[str, Any]) -> Any:
        return self._client.rpc(name, params).execute().data

    def claim(self, types: Sequence[str]) -> Job | None:
        rows = self._rpc(
            "claim_job",
            {
                "p_worker_id": self.worker_id,
                "p_lease_seconds": self.lease_seconds,
                "p_types": list(types),
            },
        )
        return Job.from_row(rows[0]) if rows else None

    def heartbeat(self, version: str, device: str, job_id: str | None) -> bool:
        """Requeues expired leases, extends job_id's lease, updates worker_status.
        Returns False when this worker no longer owns job_id."""
        return bool(
            self._rpc(
                "worker_heartbeat",
                {
                    "p_worker_id": self.worker_id,
                    "p_version": version,
                    "p_device": device,
                    "p_job_id": job_id,
                    "p_lease_seconds": self.lease_seconds,
                },
            )
        )

    def finish(
        self, job_id: str, status: str, result: dict | None = None, error: str | None = None
    ) -> bool:
        return bool(
            self._rpc(
                "finish_job",
                {
                    "p_job_id": job_id,
                    "p_worker_id": self.worker_id,
                    "p_status": status,
                    "p_result": result,
                    "p_error": error,
                },
            )
        )

    def fail(self, job_id: str, error: str, retryable: bool) -> str | None:
        """Returns the job's new status ('queued' or 'failed'), or None if no longer owned."""
        return self._rpc(
            "fail_job",
            {
                "p_job_id": job_id,
                "p_worker_id": self.worker_id,
                "p_error": error,
                "p_retryable": retryable,
            },
        )
