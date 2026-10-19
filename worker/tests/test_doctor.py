from audiotruyen_worker.doctor import CheckResult, check_r2, run_check


class FakeStorage:
    bucket = "audiotruyen"

    def __init__(self, corrupt: bool = False):
        self.objects: dict[str, bytes] = {}
        self.corrupt = corrupt

    def put_bytes(self, key, data, content_type):
        self.objects[key] = data

    def get_bytes(self, key):
        return b"other" if self.corrupt else self.objects[key]

    def delete(self, key):
        self.objects.pop(key, None)


def test_run_check_reports_success():
    assert run_check("x", lambda: "fine") == CheckResult("x", True, "fine")


def test_run_check_captures_exception():
    def boom():
        raise RuntimeError("no route")

    result = run_check("x", boom)
    assert result.ok is False
    assert result.detail == "RuntimeError: no route"


def test_check_r2_roundtrip_cleans_up():
    storage = FakeStorage()
    detail = check_r2(storage, "laptop")
    assert "audiotruyen" in detail
    assert storage.objects == {}


def test_check_r2_detects_mismatch_and_still_cleans_up():
    storage = FakeStorage(corrupt=True)
    result = run_check("r2", lambda: check_r2(storage, "laptop"))
    assert result.ok is False
    assert "mismatch" in result.detail
    assert storage.objects == {}
