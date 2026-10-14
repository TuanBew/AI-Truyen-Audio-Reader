from common import deobfuscate, extract_chapter_text, split_sentences


def test_extract_chapter_text_strips_ads_br_and_seo_tail():
    html = """
    <html><body>
    <div id="chapter-c" class="chapter-c"><div id="ads-chapter-top">QC</div>
    <p>Dòng một.<br /><br />Dòng hai.</p>
    <div class="ads-responsive">QC2</div>
    truyen full, truyenfull, truyenfullvn
    </div></body></html>
    """
    assert extract_chapter_text(html) == "Dòng một.\nDòng hai."


def test_extract_chapter_text_raises_without_container():
    import pytest

    with pytest.raises(ValueError):
        extract_chapter_text("<html><body><p>x</p></body></html>")


def test_deobfuscate_joins_dotted_letters():
    assert deobfuscate("lôi ra c.h.ử.i một trận") == "lôi ra chửi một trận"


def test_deobfuscate_leaves_normal_abbreviations():
    assert deobfuscate("v.v và TP. HCM") == "v.v và TP. HCM"


def test_split_sentences_keeps_closing_quotes():
    text = 'Ông nói: "Đi thôi!" Rồi ông đi. Hết.'
    assert split_sentences(text) == ['Ông nói: "Đi thôi!"', "Rồi ông đi.", "Hết."]


def test_split_sentences_respects_paragraphs():
    assert split_sentences("Một.\nHai.") == ["Một.", "Hai."]


def test_split_sentences_caps_length():
    long = ", ".join(["từng chữ một"] * 80) + "."
    parts = split_sentences(long, max_chars=250)
    assert len(parts) > 1
    assert all(len(p) <= 250 for p in parts)
    assert " ".join(parts).replace(" ", "") == long.replace(" ", "")
