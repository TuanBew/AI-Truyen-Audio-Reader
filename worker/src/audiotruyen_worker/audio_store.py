"""Database access for synthesize / cleanup_r2 / GC (service role; scoped by the caller)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from audiotruyen_worker.text.normalize import LexiconRule
from audiotruyen_worker.tts.base import VoiceRef


@dataclass(frozen=True)
class AudioRow:
    id: str
    attempt: int
    status: str


@dataclass(frozen=True)
class GcCandidate:
    key: str
    chapter_audio_id: str
    stale: bool


class AudioStore:
    def __init__(self, client) -> None:
        self._db = client

    def _rpc(self, name: str, params: dict[str, Any]) -> Any:
        return self._db.rpc(name, params).execute().data

    # ---- chapter_audio -----------------------------------------------------------------

    def begin(self, chapter_id: str, voice_hash: str) -> AudioRow:
        (row,) = self._rpc(
            "begin_chapter_audio", {"p_chapter_id": chapter_id, "p_voice_hash": voice_hash}
        )
        return AudioRow(row["id"], row["attempt"], row["status"])

    def update(self, row: AudioRow, fields: dict[str, Any]) -> bool:
        """Fenced by attempt (spec 5.1): False when a newer attempt owns the row."""
        data = (
            self._db.table("chapter_audio")
            .update(fields)
            .eq("id", row.id)
            .eq("attempt", row.attempt)
            .execute()
            .data
        )
        return bool(data)

    # ---- voices, lexicon, hash -----------------------------------------------------------

    def voice_hash(self, novel_id: str) -> str:
        return self._rpc("current_voice_hash", {"p_novel_id": novel_id})

    def default_narrator(self, user_id: str) -> VoiceRef | None:
        data = (
            self._db.table("voices")
            .select("id,kind,preset_name")
            .eq("user_id", user_id)
            .eq("is_default_narrator", True)
            .limit(1)
            .execute()
            .data
        )
        if not data or not data[0]["preset_name"]:
            return None
        return VoiceRef(data[0]["id"], preset=data[0]["preset_name"])

    def lexicon(self, user_id: str, novel_id: str) -> list[LexiconRule]:
        """Enabled rules: global ones by position, then the novel's (spec 5.3)."""
        rows = (
            self._db.table("lexicon")
            .select("novel_id,pattern,replacement,is_regex,position,id")
            .eq("user_id", user_id)
            .eq("enabled", True)
            .or_(f"novel_id.is.null,novel_id.eq.{novel_id}")
            .execute()
            .data
        )
        rows.sort(key=lambda r: (r["novel_id"] is not None, r["position"], r["id"]))
        return [LexiconRule(r["pattern"], r["replacement"], r["is_regex"]) for r in rows]

    def upsert_preset_voice(
        self, user_id: str, name: str, gender: str, *, narrator: bool, male: bool, female: bool
    ) -> str:
        row = {
            "user_id": user_id,
            "name": name,
            "kind": "preset",
            "preset_name": name,
            "gender": gender,
            "is_default_narrator": narrator,
            "is_default_male": male,
            "is_default_female": female,
        }
        data = self._db.table("voices").upsert(row, on_conflict="user_id,name").execute().data
        return data[0]["id"]

    def clear_default_flags(self, user_id: str) -> None:
        for flag in ("is_default_narrator", "is_default_male", "is_default_female"):
            self._db.table("voices").update({flag: False}).eq("user_id", user_id).eq(
                flag, True
            ).execute()

    # ---- R2 ledger ------------------------------------------------------------------------

    def live_keys(self, prefix: str, after: str = "", limit: int = 1000) -> list[str]:
        return list(
            self._rpc("r2_live_keys", {"p_prefix": prefix, "p_after": after, "p_limit": limit})
            or []
        )

    def mark_deleted(self, keys: list[str]) -> int:
        return int(self._rpc("r2_mark_deleted", {"p_keys": keys}) or 0)

    def usage(self) -> dict[str, int]:
        (row,) = self._rpc("r2_usage", {})
        return {k: int(v) for k, v in row.items()}

    def gc_candidates(self, limit: int = 1000) -> list[GcCandidate]:
        rows = self._rpc("r2_gc_candidates", {"p_limit": limit}) or []
        return [GcCandidate(r["key"], r["chapter_audio_id"], r["stale"]) for r in rows]

    def delete_audio_rows(self, ids: list[str]) -> None:
        if ids:
            self._db.table("chapter_audio").delete().in_("id", ids).execute()
