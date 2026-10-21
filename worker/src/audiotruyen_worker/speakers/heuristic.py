"""Heuristic speaker/emotion strategy (spec 5.4): attribution verbs and names/pronouns in the
narration next to a dialogue segment; emotion from verbs and punctuation. Never fails."""

from __future__ import annotations

import re
from collections.abc import Sequence

from audiotruyen_worker.speakers.base import Character, Emotion, Gender, SegmentLabel
from audiotruyen_worker.text.segment import Segment

# Ordered: first match wins, so multi-word and stronger cues come first.
_EMOTION_CUES: list[tuple[str, Emotion]] = [
    (r"thì thầm|thầm thì|nói nhỏ|thì thào|khẽ nói|ghé tai", "whisper"),
    (r"gào|hét lớn|thét|rống|la lớn", "shout"),
    (r"quát|gầm|gắt|nổi giận|giận dữ|tức giận|lạnh lùng nói|nghiến răng", "angry"),
    (r"nức nở|nghẹn ngào|khóc|thút thít|bi thương|thở dài", "sad"),
    (r"run rẩy|sợ hãi|hoảng|kinh hãi|run giọng|lắp bắp", "fearful"),
    (r"dịu dàng|ôn nhu|âu yếm|nhẹ nhàng nói|cưng chiều", "tender"),
    (r"cười|vui vẻ|hớn hở|reo|hào hứng", "happy"),
]
_EMOTION_RES = [(re.compile(rf"(?<!\w)(?:{p})(?!\w)", re.IGNORECASE), e) for p, e in _EMOTION_CUES]
_SPEECH_VERB = re.compile(
    r"(?<!\w)(?:nói|hỏi|đáp|quát|gầm|hét|gào|thét|gắt|kêu|lẩm bẩm|thì thầm|thầm thì|cười|"
    r"khóc|lên tiếng|mở miệng|trả lời|hừ|than|thở dài|nhắc|bảo)(?!\w)",
    re.IGNORECASE,
)
_PRONOUNS: dict[str, Gender] = {
    "anh": "male", "hắn": "male", "ông": "male", "gã": "male", "lão": "male", "chàng": "male",
    "cậu": "male", "thằng": "male",
    "cô": "female", "nàng": "female", "bà": "female", "ả": "female",
    "chị": "female", "muội": "female", "cô ấy": "female", "bà ấy": "female",
}  # fmt: skip
_PRONOUN_RE = re.compile(
    r"(?<!\w)(" + "|".join(sorted(map(re.escape, _PRONOUNS), key=len, reverse=True)) + r")(?!\w)",
    re.IGNORECASE,
)


class HeuristicStrategy:
    name = "heuristic"
    version = 1

    def analyze(
        self, segments: Sequence[Segment], roster: Sequence[Character]
    ) -> list[SegmentLabel]:
        names = sorted(
            ((alias, c) for c in roster for alias in (c.name, *c.aliases) if alias),
            key=lambda pair: len(pair[0]),
            reverse=True,
        )
        labels = []
        for seg in segments:
            if seg.kind == "narration":
                labels.append(SegmentLabel(seg.i, None, "unknown", "neutral", 0.0))
                continue
            context = _attribution_context(segments, seg)
            speaker, gender = _find_speaker(context, names)
            emotion, intensity = _emotion(seg.text, context)
            labels.append(SegmentLabel(seg.i, speaker, gender, emotion, intensity))
        return labels


def _attribution_context(segments: Sequence[Segment], seg: Segment) -> str:
    """Narration in the same paragraph right after the dialogue, else right before it.
    Only narration that contains a speech verb counts as attribution."""
    after = segments[seg.i + 1] if seg.i + 1 < len(segments) else None
    before = segments[seg.i - 1] if seg.i > 0 else None
    for cand in (after, before):
        if cand and cand.kind == "narration" and cand.paragraph == seg.paragraph:
            if _SPEECH_VERB.search(cand.text):
                return cand.text
    return ""


def _find_speaker(context: str, names: list[tuple[str, Character]]) -> tuple[str | None, Gender]:
    if not context:
        return None, "unknown"
    best: tuple[int, str | None, Gender] = (len(context) + 1, None, "unknown")
    for alias, character in names:
        pos = context.find(alias)
        if 0 <= pos < best[0]:
            best = (pos, character.name, character.gender)
    match = _PRONOUN_RE.search(context)
    if match and match.start() < best[0]:
        return None, _PRONOUNS[match.group(1).lower()]
    return best[1], best[2]


def _emotion(dialogue: str, context: str) -> tuple[Emotion, float]:
    emotion: Emotion = "neutral"
    intensity = 0.0
    for pattern, label in _EMOTION_RES:
        if context and pattern.search(context):
            emotion, intensity = label, 0.5
            break
    stripped = dialogue.rstrip('"”’» ')
    exclaims = stripped.count("!")
    if exclaims:
        if emotion == "neutral":
            emotion, intensity = ("shout", 0.6) if exclaims >= 2 else ("neutral", 0.3)
        intensity = min(1.0, intensity + 0.2 * min(exclaims, 2))
    elif emotion == "neutral" and stripped.endswith(("...", "…")):
        emotion, intensity = "sad", 0.3
    return emotion, round(intensity, 2)
