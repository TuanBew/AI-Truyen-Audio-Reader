from pathlib import Path

from audiotruyen_worker.sources.truyenfull_parse import parse_chapter_page
from audiotruyen_worker.text.segment import MAX_CHARS, segment_text

FIXTURES = Path(__file__).parent / "fixtures" / "truyenfull"


def test_segments_map_back_to_the_original_text():
    text = parse_chapter_page((FIXTURES / "chapter_new_354.html").read_text(encoding="utf-8")).text
    segments = segment_text(text)
    assert segments, "no segments"
    assert [s.i for s in segments] == list(range(len(segments)))
    for s in segments:
        assert text[s.start : s.end] == s.text
        assert len(s.text) <= MAX_CHARS
    starts = [s.start for s in segments]
    assert starts == sorted(starts)


def test_quoted_dialogue_and_narration_in_one_paragraph():
    text = "Hứa Niết nói:\n“Ta không buông.” Hắn gầm lên giận dữ. “Buông ra!”"
    segs = segment_text(text)
    assert [(s.kind, s.text) for s in segs] == [
        ("narration", "Hứa Niết nói:"),
        ("dialogue", "“Ta không buông.”"),
        ("narration", "Hắn gầm lên giận dữ."),
        ("dialogue", "“Buông ra!”"),
    ]
    assert [s.paragraph for s in segs] == [0, 1, 1, 1]
    assert [s.paragraph_end for s in segs] == [True, False, False, True]


def test_straight_quotes_nested_single_quotes_and_unclosed_quote():
    segs = segment_text('Hắn nói: "Nàng bảo ‘đi đi’ rồi." Rồi im lặng.\n"Chưa xong')
    assert [(s.kind, s.text) for s in segs] == [
        ("narration", "Hắn nói:"),
        ("dialogue", '"Nàng bảo ‘đi đi’ rồi."'),
        ("narration", "Rồi im lặng."),
        ("dialogue", '"Chưa xong'),
    ]


def test_dash_led_dialogue():
    segs = segment_text("- Ngươi muốn chết sao? - Lâm Phong quát.\n– Không dám.")
    assert [(s.kind, s.text) for s in segs] == [
        ("dialogue", "- Ngươi muốn chết sao?"),
        ("narration", "- Lâm Phong quát."),
        ("dialogue", "– Không dám."),
    ]


def test_dash_led_line_alternates_dialogue_and_narration_at_every_spaced_dash():
    text = "- Ngươi - Lâm Phong quát - cút ngay!"
    segs = segment_text(text)
    assert [(s.kind, s.text) for s in segs] == [
        ("dialogue", "- Ngươi"),
        ("narration", "- Lâm Phong quát"),
        ("dialogue", "- cút ngay!"),
    ]
    assert all(text[s.start : s.end] == s.text for s in segs)


def test_long_paragraph_is_split_at_sentence_ends():
    sentence = "Hắn đi qua cánh rừng già rậm rạp, nghe tiếng gió thổi qua những tán lá cao vút. "
    text = (sentence * 8).strip()
    segs = segment_text(text)
    assert len(segs) > 1
    assert all(len(s.text) <= MAX_CHARS for s in segs)
    assert all(s.text.endswith(".") for s in segs)
    assert "".join(text[s.start : s.end] for s in segs).replace(" ", "") == text.replace(" ", "")


def test_sentence_longer_than_limit_is_cut_at_clause_or_space():
    text = ", ".join(["một đoạn văn rất dài không có dấu chấm"] * 12)
    segs = segment_text(text)
    assert len(segs) > 1 and all(len(s.text) <= MAX_CHARS for s in segs)


def test_punctuation_only_pieces_are_dropped():
    segs = segment_text("“Ừ.” ,\n...")
    assert [s.text for s in segs] == ["“Ừ.”"]
