"""Speaker/emotion strategy contract (spec 4.1, 5.4) and the strategy chain."""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Literal, Protocol

from audiotruyen_worker.text.segment import Segment

Gender = Literal["male", "female", "unknown"]
Emotion = Literal["neutral", "happy", "sad", "angry", "fearful", "whisper", "shout", "tender"]
GENDERS: frozenset[str] = frozenset({"male", "female", "unknown"})
EMOTIONS: frozenset[str] = frozenset(
    {"neutral", "happy", "sad", "angry", "fearful", "whisper", "shout", "tender"}
)

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Character:
    name: str
    gender: Gender = "unknown"
    aliases: tuple[str, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class SegmentLabel:
    i: int
    speaker: str | None
    gender: Gender
    emotion: Emotion
    intensity: float


class SpeakerStrategy(Protocol):
    name: str
    version: int

    def analyze(
        self, segments: Sequence[Segment], roster: Sequence[Character]
    ) -> list[SegmentLabel]: ...


class InvalidLabels(ValueError):
    pass


def validate_labels(segments: Sequence[Segment], labels: Sequence[SegmentLabel]) -> None:
    """Accept a strategy result only if it labels every segment exactly once with valid values."""
    if sorted(label.i for label in labels) != [s.i for s in segments]:
        raise InvalidLabels("labels do not cover every segment exactly once")
    for label in labels:
        if label.gender not in GENDERS or label.emotion not in EMOTIONS:
            raise InvalidLabels(f"segment {label.i}: bad gender/emotion")
        if not 0.0 <= label.intensity <= 1.0:
            raise InvalidLabels(f"segment {label.i}: intensity out of range")


@dataclass(frozen=True)
class ChainResult:
    strategy: str
    version: int
    labels: list[SegmentLabel]


def run_chain(
    strategies: Sequence[SpeakerStrategy],
    segments: Sequence[Segment],
    roster: Sequence[Character],
) -> ChainResult:
    """Try strategies in order; the first valid result wins. The last strategy (heuristic) must
    not fail; if every strategy fails, the last error is raised."""
    error: Exception | None = None
    for strategy in strategies:
        try:
            labels = sorted(strategy.analyze(segments, roster), key=lambda label: label.i)
            validate_labels(segments, labels)
        except Exception as exc:  # any strategy failure falls through to the next one
            log.warning("strategy %s failed: %s", strategy.name, exc)
            error = exc
            continue
        return ChainResult(strategy.name, strategy.version, labels)
    raise error or InvalidLabels("no strategies configured")
