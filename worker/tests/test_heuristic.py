import pytest

from audiotruyen_worker.speakers.base import Character, InvalidLabels, SegmentLabel, run_chain
from audiotruyen_worker.speakers.heuristic import HeuristicStrategy
from audiotruyen_worker.text.segment import segment_text


def test_heuristic_labels_speaker_gender_and_emotion():
    text = (
        "“Ngươi dám!” Lâm Phong quát.\n"
        "Nàng thì thầm: “Đừng đi...”\n"
        "“Ha ha, tốt lắm!!”\n"
        "Trời tối dần."
    )
    roster = [Character("Lâm Phong", "male")]
    segs = segment_text(text)
    labels = {label.i: label for label in HeuristicStrategy().analyze(segs, roster)}
    by_text = {s.text: labels[s.i] for s in segs}
    assert by_text["“Ngươi dám!”"] == SegmentLabel(0, "Lâm Phong", "male", "angry", 0.7)
    whisper = by_text["“Đừng đi...”"]
    assert (whisper.speaker, whisper.gender, whisper.emotion) == (None, "female", "whisper")
    shout = by_text["“Ha ha, tốt lắm!!”"]
    assert (shout.emotion, shout.intensity) == ("shout", 1.0)
    narration = by_text["Trời tối dần."]
    assert (narration.speaker, narration.gender, narration.emotion, narration.intensity) == (
        None, "unknown", "neutral", 0.0,
    )  # fmt: skip


def test_heuristic_alias_matches_and_speech_verb_is_required():
    roster = [Character("Thạch Uẩn Ngọc", "female", ("Thúy Thúy",))]
    segs = segment_text("Thúy Thúy cười: “Được.”\nThúy Thúy đứng dậy. “Đi thôi.”")
    labels = HeuristicStrategy().analyze(segs, roster)
    dialogue = [label for s, label in zip(segs, labels, strict=True) if s.kind == "dialogue"]
    assert (dialogue[0].speaker, dialogue[0].emotion) == ("Thạch Uẩn Ngọc", "happy")
    assert dialogue[1].speaker is None  # "đứng dậy" is not a speech verb


class _Broken:
    name, version = "broken", 1

    def analyze(self, segments, roster):
        return [SegmentLabel(0, None, "unknown", "neutral", 0.0)]  # misses segments


class _Raises:
    name, version = "raises", 1

    def analyze(self, segments, roster):
        raise RuntimeError("model down")


def test_chain_falls_through_to_the_first_valid_strategy():
    segs = segment_text("“A.” Hắn nói.\nB.")
    result = run_chain([_Raises(), _Broken(), HeuristicStrategy()], segs, [])
    assert (result.strategy, result.version) == ("heuristic", 1)
    assert [label.i for label in result.labels] == [s.i for s in segs]


def test_chain_raises_when_every_strategy_fails():
    with pytest.raises(InvalidLabels):
        run_chain([_Broken()], segment_text("A.\nB."), [])
