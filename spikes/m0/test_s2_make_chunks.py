from s2_make_chunks import encode_continuous, sine, split_webm

EBML_ID = bytes.fromhex("1A45DFA3")
CLUSTER_ID = bytes.fromhex("1F43B675")


def test_split_webm_yields_init_plus_cluster_segments():
    data = encode_continuous(sine(3.0), 1.0)
    init, segments = split_webm(data)
    assert init.startswith(EBML_ID)
    assert CLUSTER_ID not in init
    assert len(segments) >= 3
    for seg in segments:
        assert seg.data.startswith(CLUSTER_ID)
    assert init + b"".join(seg.data for seg in segments) == data
    starts = [seg.timestamp_ms for seg in segments]
    assert starts[0] == 0
    assert starts == sorted(starts)
