import pytest

from audiotruyen_worker.text.normalize import (
    LexiconRule,
    apply_lexicon,
    deobfuscate,
    normalize_for_tts,
    uncensor,
)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("thảo d.ư.ợ.c", "thảo dược"),
        ("b.út kẻ", "bút kẻ"),
        ("c.h.ử.i ầm lên.", "chửi ầm lên."),
        ("C.h.ế.t đi", "Chết đi"),
        ("ch.ết", "chết"),
        ("công t.ử", "công tử"),
        ("l.ồ.ng n.g.ự.c", "lồng ngực"),
        ("v.v.", "v.v."),
        ("TP.HCM", "TP.HCM"),
        ("nói.Ai", "nói.Ai"),
        ("là.ta", "là.ta"),
        ("đi.về", "đi.về"),
        ("A.B", "A.B"),
        ("1.000.000 đồng", "1.000.000 đồng"),
    ],
)
def test_deobfuscate(raw, expected):
    assert deobfuscate(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("ai g**t ch*t lão", "ai giết chết lão"),
        ("G**t hắn", "Giết hắn"),
        ("đồ đ**m kia", "đồ kia"),
        ("không có sao", "không có sao"),
        ("*Bốp* một tiếng", "Bốp một tiếng"),
        ("*nói nhỏ* thôi", "nói nhỏ thôi"),
        ("Hạo Thiên* là ai", "Hạo Thiên là ai"),
    ],
)
def test_uncensor(raw, expected):
    assert uncensor(raw) == expected


def test_lexicon_plain_rules_are_whole_word_and_ordered():
    rules = [LexiconRule("Hạo", "Hạo Thiên"), LexiconRule("Hạo Thiên", "Hạo Thiên Đế")]
    assert apply_lexicon("Hạo đến, Hạo Nhi đi", rules) == "Hạo Thiên Đế đến, Hạo Thiên Đế Nhi đi"


def test_lexicon_regex_rule_and_invalid_regex_is_skipped():
    rules = [
        LexiconRule("(", "x", is_regex=True),
        LexiconRule(r"(\d+)\s*lượng", r"\1 lạng", is_regex=True),
    ]
    assert apply_lexicon("trả 5 lượng", rules) == "trả 5 lạng"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (
            "Ta cũng chỉ nghe nói, kia là Xích Viêm Long.",
            "ta cũng chỉ nghe nói, kia là xích viêm long.",
        ),
        ("Năm 1999, hắn 18 tuổi.", "năm một nghìn chín trăm chín mươi chín, hắn mười tám tuổi."),
        ("Trả 50.000đ, cách 3km.", "trả năm mươi nghìn đồng, cách ba ki-lô-mét."),
        ("“Thảo d.ư.ợ.c, g**t hắn!”", "thảo dược, giết hắn!"),
    ],
)
def test_normalize_for_tts(raw, expected):
    assert normalize_for_tts(raw) == expected
