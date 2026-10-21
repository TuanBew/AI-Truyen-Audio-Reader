"""TTS input normalization (spec 5.3 step 1). Display text is never changed; segments are cut
from the original text first and each segment's text is normalized here for synthesis."""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

_LETTER = r"[^\W\d_]"
# Letter groups of 1-2 letters separated by single dots: "c.h.ử.i", "d.ư.ợ.c", "b.út", "ch.ết".
_DOTTED = re.compile(rf"(?<![\w.])({_LETTER}{{1,2}}(?:\.{_LETTER}{{1,2}})+)(?![\w]|\.\w)")
# Words censored with asterisks, e.g. "g**t ch*t".
_ASTERISK_WORD = re.compile(rf"(?<!\w){_LETTER}*\*+{_LETTER}*(?:\*+{_LETTER}*)*(?!\w)")
CENSORED = {"g**t": "giết", "g*t": "giết", "ch*t": "chết", "ch**t": "chết"}


def _has_vowel(part: str) -> bool:
    base = unicodedata.normalize("NFD", part.lower())
    return any(ch in "aeiouy" for ch in base)


def _join_dotted(match: re.Match[str]) -> str:
    token = match.group(1)
    parts = token.split(".")
    if any(p[1:] != p[1:].lower() for p in parts) or any(p[:1].isupper() for p in parts[1:]):
        return token  # "TP.HCM", "là.Ta": abbreviations or a missing space after a period
    if len(parts) == 2 and _has_vowel(parts[0]):
        return token  # "v.v", "A.B", "là.ta", "đi.về": not one obfuscated word
    joined = "".join(parts)
    return joined if _has_vowel(joined) else token


def deobfuscate(text: str) -> str:
    """'c.h.ử.i' -> 'chửi', 'b.út' -> 'bút'; leaves 'v.v.', 'TP.HCM' and 'là.Ta' alone."""
    return _DOTTED.sub(_join_dotted, text)


def uncensor(text: str) -> str:
    """Restore known asterisk-censored words; drop unknown ones (never read them as noise)."""

    def repl(match: re.Match[str]) -> str:
        word = match.group(0)
        known = CENSORED.get(word.lower())
        if known is None:
            return ""
        return known.capitalize() if word[:1].isupper() else known

    return re.sub(r"[ \t]{2,}", " ", _ASTERISK_WORD.sub(repl, text))


@dataclass(frozen=True)
class LexiconRule:
    pattern: str
    replacement: str
    is_regex: bool = False


def apply_lexicon(text: str, rules: Sequence[LexiconRule]) -> str:
    """Rules apply in the given order (global by position, then novel-level). Plain rules are
    case-sensitive whole-word replacements; regex rules use Python `re` syntax. Invalid regex
    rules are skipped."""
    for rule in rules:
        if rule.is_regex:
            try:
                text = re.sub(rule.pattern, rule.replacement, text)
            except re.error:
                continue
        elif rule.pattern:
            text = re.sub(
                rf"(?<!\w){re.escape(rule.pattern)}(?!\w)", lambda _m, r=rule: r.replacement, text
            )
    return text


_EMPTY_DICT = str(Path(__file__).parent / "data" / "vietnormalizer_empty.csv")


@lru_cache(maxsize=1)
def _vietnormalizer():
    from vietnormalizer import VietnameseNormalizer

    # Its built-in "non-Vietnamese words" dictionary and transliteration rewrite common
    # Vietnamese words ("nghe" -> "nghê", "long" -> "lon", "kia" -> "ki-a"), so both are off and
    # only the number/date/unit rules are used.
    return VietnameseNormalizer(
        non_vietnamese_words_path=_EMPTY_DICT,
        acronyms_path=_EMPTY_DICT,
        enable_transliteration=False,
    )


def normalize_for_tts(text: str, rules: Sequence[LexiconRule] = ()) -> str:
    """NFC -> de-obfuscate -> uncensor -> lexicon -> vietnormalizer (numbers, dates, units,
    abbreviations; lowercases and drops quote marks)."""
    text = unicodedata.normalize("NFC", text)
    text = uncensor(deobfuscate(text))
    text = apply_lexicon(text, rules)
    return _vietnormalizer().normalize(text).strip()
