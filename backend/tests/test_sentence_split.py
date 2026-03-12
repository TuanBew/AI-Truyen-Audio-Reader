"""Tests for Vietnamese sentence-splitting endpoint."""
import pytest


async def test_split_basic_sentences(client):
    response = await client.post(
        "/api/tts/split-sentences",
        json={"text": "Xin chào. Tôi là AI. Bạn khỏe không?"}
    )
    assert response.status_code == 200
    assert response.json()["sentences"] == ["Xin chào.", "Tôi là AI.", "Bạn khỏe không?"]


async def test_split_preserves_ellipsis(client):
    response = await client.post(
        "/api/tts/split-sentences",
        json={"text": "Anh ấy dừng lại... rồi tiếp tục."}
    )
    assert response.status_code == 200
    assert len(response.json()["sentences"]) == 1


async def test_split_enforces_max_chars(client):
    long_sentence = ("Từ " * 120).strip()   # ~480 chars
    response = await client.post("/api/tts/split-sentences", json={"text": long_sentence})
    assert response.status_code == 200
    for s in response.json()["sentences"]:
        assert len(s) <= 300


async def test_split_rejects_oversized_input(client):
    response = await client.post("/api/tts/split-sentences", json={"text": "x" * 5001})
    assert response.status_code == 422


async def test_split_merges_short_sentences(client):
    response = await client.post("/api/tts/split-sentences", json={"text": "Ừ. Tôi hiểu rồi."})
    assert response.status_code == 200
    # "Ừ." is 3 chars → merged with next sentence
    assert len(response.json()["sentences"]) == 1
