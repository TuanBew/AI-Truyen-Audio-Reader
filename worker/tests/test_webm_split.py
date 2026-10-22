import subprocess

import numpy as np
import pytest

from audiotruyen_worker.audio.encoder import FFMPEG_ARGS
from audiotruyen_worker.audio.webm_split import (
    ClusterSegment,
    InitSegment,
    WebmError,
    WebmSplitter,
)


def _vint(value: int, length: int) -> bytes:
    return ((1 << (7 * length)) | value).to_bytes(length, "big")


def _element(elem_id: bytes, payload: bytes) -> bytes:
    return elem_id + _vint(len(payload), 4) + payload


UNKNOWN = b"\x01\xff\xff\xff\xff\xff\xff\xff"
EBML = _element(b"\x1a\x45\xdf\xa3", b"\x42\x86\x81\x01")
INFO = _element(b"\x15\x49\xa9\x66", b"\x2a\xd7\xb1\x83\x0f\x42\x40")


def _cluster(timestamp: int, block: bytes, known: bool) -> bytes:
    body = _element(b"\xe7", timestamp.to_bytes(2, "big")) + _element(b"\xa3", block)
    if known:
        return _element(b"\x1f\x43\xb6\x75", body)
    return b"\x1f\x43\xb6\x75" + UNKNOWN + body


def _stream(known: bool) -> tuple[bytes, list[bytes]]:
    clusters = [_cluster(t, bytes([t % 251]) * 40, known) for t in (0, 10_000, 20_000)]
    return EBML + b"\x18\x53\x80\x67" + UNKNOWN + INFO, clusters


def _split(data: bytes, step: int) -> list:
    splitter = WebmSplitter()
    out = []
    for start in range(0, len(data), step):
        out.extend(splitter.feed(data[start : start + step]))
    out.extend(splitter.finish())
    return out


@pytest.mark.parametrize("known", [True, False])
@pytest.mark.parametrize("step", [1, 7, 4096])
def test_split_init_and_clusters_in_any_chunking(known, step):
    init, clusters = _stream(known)
    parts = _split(init + b"".join(clusters), step)
    assert isinstance(parts[0], InitSegment) and parts[0].data == init
    assert [p.data for p in parts[1:]] == clusters
    assert [(p.index, p.timestamp_ms) for p in parts[1:]] == [(0, 0), (1, 10_000), (2, 20_000)]


def test_known_size_cluster_is_emitted_as_soon_as_it_is_complete():
    init, clusters = _stream(known=True)
    splitter = WebmSplitter()
    first = list(splitter.feed(init + clusters[0]))
    assert [type(p) for p in first] == [InitSegment, ClusterSegment]


def test_unknown_size_cluster_waits_for_the_next_level1_element():
    init, clusters = _stream(known=False)
    splitter = WebmSplitter()
    assert [type(p) for p in splitter.feed(init + clusters[0])] == [InitSegment]
    assert [p.index for p in splitter.feed(clusters[1])] == [0]
    assert [p.index for p in splitter.finish()] == [1]


def test_errors():
    with pytest.raises(WebmError, match="not an EBML"):
        list(WebmSplitter().feed(b"\x42\x86\x81\x01" * 4))
    splitter = WebmSplitter()
    list(splitter.feed(EBML + b"\x18\x53\x80\x67" + UNKNOWN))
    with pytest.raises(WebmError, match="before the first Cluster"):
        list(splitter.finish())


def test_real_ffmpeg_live_output_round_trips():
    pcm = (0.3 * np.sin(2 * np.pi * 440 * np.arange(25 * 48_000) / 48_000)).astype("<f4")
    data = subprocess.run(
        ["ffmpeg", *FFMPEG_ARGS], input=pcm.tobytes(), capture_output=True, check=True
    ).stdout
    parts = _split(data, 3000)
    assert b"".join(p.data for p in parts) == data
    stamps = [p.timestamp_ms for p in parts[1:]]
    assert len(stamps) == 3 and stamps[0] == 0
    assert all(0 <= 10_000 * k - ts < 50 for k, ts in enumerate(stamps))  # ffmpeg cuts ~19 ms early
