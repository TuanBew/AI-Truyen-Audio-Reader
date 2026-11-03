import pytest

from audiotruyen_worker.audio_store import AudioRow, AudioStore


class ExplodingClient:
    def table(self, name):
        raise AssertionError("the guard must reject the update before any request")


@pytest.mark.parametrize("field", ["id", "attempt"])
def test_update_refuses_to_change_the_fence_columns(field):
    store = AudioStore(ExplodingClient())
    with pytest.raises(ValueError, match="fence"):
        store.update(AudioRow("a", 1, "queued"), {field: 99, "status": "ready"})


def test_set_default_rejects_unknown_flags():
    with pytest.raises(ValueError):
        AudioStore(ExplodingClient()).set_default_if_unheld("u", "v", "is_admin")
