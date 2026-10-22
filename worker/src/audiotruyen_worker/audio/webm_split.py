"""Incremental WebM splitter (spec 4.3, 5.6): turns the live encoder's byte stream into the
shared init segment (everything before the first Cluster) and one media segment per Cluster,
each emitted as soon as it is complete. Cut points and timestamps come from the muxed stream."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass

EBML_HEADER_ID = 0x1A45DFA3
SEGMENT_ID = 0x18538067
CLUSTER_ID = 0x1F43B675
TIMESTAMP_ID = 0xE7
# Segment children (level 1). Any of them ends an unknown-size Cluster.
LEVEL1_IDS = frozenset(
    {CLUSTER_ID, 0x1C53BB6B, 0x114D9B74, 0x1549A966, 0x1654AE6B, 0x1254C367, 0x1043A770, 0x1941A469}
)


class WebmError(ValueError):
    pass


@dataclass(frozen=True)
class InitSegment:
    data: bytes


@dataclass(frozen=True)
class ClusterSegment:
    index: int
    data: bytes
    timestamp_ms: int


def _vint_len(first: int) -> int:
    for length in range(1, 9):
        if first & (0x80 >> (length - 1)):
            return length
    raise WebmError("invalid EBML vint")


def _read_id(buf: bytes | bytearray, pos: int) -> tuple[int, int] | None:
    if pos >= len(buf):
        return None
    length = _vint_len(buf[pos])
    if pos + length > len(buf):
        return None
    return int.from_bytes(buf[pos : pos + length], "big"), pos + length


def _read_size(buf: bytes | bytearray, pos: int) -> tuple[int | None, int] | None:
    if pos >= len(buf):
        return None
    length = _vint_len(buf[pos])
    if pos + length > len(buf):
        return None
    value = int.from_bytes(buf[pos : pos + length], "big") & ((1 << (7 * length)) - 1)
    unknown = value == (1 << (7 * length)) - 1
    return (None if unknown else value), pos + length


def _cluster_timestamp(buf: bytes | bytearray, pos: int, end: int) -> int:
    """Timestamp child of a complete Cluster (0 if absent)."""
    while pos < end:
        head = _read_id(buf, pos)
        size = _read_size(buf, head[1]) if head else None
        if head is None or size is None or size[0] is None:
            raise WebmError("malformed Cluster child")
        if head[0] == TIMESTAMP_ID:
            return int.from_bytes(buf[size[1] : size[1] + size[0]], "big")
        pos = size[1] + size[0]
    return 0


class WebmSplitter:
    """Feed bytes with `feed()`; it yields InitSegment once, then ClusterSegment per finished
    Cluster. Call `finish()` at end of stream to flush the last Cluster."""

    def __init__(self) -> None:
        self._buf = bytearray()
        self._pos = 0  # parse position in _buf
        self._state = "header"
        self._init_end: int | None = None
        self._cluster_start: int | None = None
        self._cluster_ts = 0
        self._index = 0

    def feed(self, data: bytes) -> Iterator[InitSegment | ClusterSegment]:
        self._buf += data
        yield from self._parse()

    def finish(self) -> Iterator[InitSegment | ClusterSegment]:
        yield from self._parse()
        if self._state != "segment" or self._init_end is None:
            raise WebmError("stream ended before the first Cluster")
        if self._cluster_start is not None:
            if self._pos != len(self._buf):
                raise WebmError("stream ended inside a Cluster child element")
            yield self._emit_cluster(len(self._buf))

    def _emit_cluster(self, end: int) -> ClusterSegment:
        assert self._cluster_start is not None
        segment = ClusterSegment(
            self._index, bytes(self._buf[self._cluster_start : end]), self._cluster_ts
        )
        self._index += 1
        # Drop emitted bytes so memory stays bounded for long chapters.
        del self._buf[:end]
        self._pos = max(0, self._pos - end)
        self._cluster_start = None
        return segment

    def _parse(self) -> Iterator[InitSegment | ClusterSegment]:
        buf = self._buf
        while True:
            if self._state == "header":
                head = _read_id(buf, self._pos)
                if head is None:
                    return
                elem_id, after = head
                if elem_id != EBML_HEADER_ID:
                    raise WebmError("not an EBML stream")
                size = _read_size(buf, after)
                if size is None or size[0] is None or size[1] + size[0] > len(buf):
                    return
                self._pos = size[1] + size[0]
                self._state = "segment_header"
            elif self._state == "segment_header":
                head = _read_id(buf, self._pos)
                if head is None:
                    return
                elem_id, after = head
                if elem_id != SEGMENT_ID:
                    raise WebmError(f"expected Segment, got 0x{elem_id:X}")
                size = _read_size(buf, after)
                if size is None:
                    return
                self._pos = size[1]
                self._state = "segment"
            else:
                head = _read_id(buf, self._pos)
                if head is None:
                    return
                elem_id, after = head
                size = _read_size(buf, after)
                if size is None:
                    return
                length, data_start = size
                if self._cluster_start is not None and elem_id in LEVEL1_IDS:
                    yield self._emit_cluster(self._pos)
                    continue  # re-read this element at its new position
                if elem_id == CLUSTER_ID:
                    if self._init_end is None:
                        self._init_end = self._pos
                        init = InitSegment(bytes(buf[: self._pos]))
                        del buf[: self._pos]
                        self._pos = 0
                        yield init
                        continue
                    if length is not None:
                        # ffmpeg writes each finished Cluster in one piece with its size.
                        if data_start + length > len(buf):
                            return
                        self._cluster_start = self._pos
                        self._cluster_ts = _cluster_timestamp(buf, data_start, data_start + length)
                        yield self._emit_cluster(data_start + length)
                        continue
                    self._cluster_start = self._pos
                    self._cluster_ts = 0
                    self._pos = data_start
                    continue
                if length is None:
                    raise WebmError(f"unknown-size element 0x{elem_id:X}")
                if data_start + length > len(buf):
                    return
                if elem_id == TIMESTAMP_ID and self._cluster_start is not None:
                    self._cluster_ts = int.from_bytes(buf[data_start : data_start + length], "big")
                if self._cluster_start is None and self._init_end is not None:
                    raise WebmError(
                        f"unexpected level-1 element 0x{elem_id:X} after the init segment"
                    )
                self._pos = data_start + length
