import pytest
from pydantic import ValidationError

from audiotruyen_worker.config import load_settings

REQUIRED = {
    "SUPABASE_URL": "http://127.0.0.1:54321",
    "SUPABASE_SERVICE_ROLE_KEY": "service-key",
    "R2_ACCOUNT_ID": "acc123",
    "R2_ACCESS_KEY_ID": "id",
    "R2_SECRET_ACCESS_KEY": "r2-hidden-value",
    "R2_BUCKET": "audiotruyen",
}


@pytest.fixture
def env(monkeypatch):
    for key, value in REQUIRED.items():
        monkeypatch.setenv(key, value)
    return monkeypatch


def test_loads_required_values(env):
    settings = load_settings(_env_file=None)
    assert settings.supabase_url == "http://127.0.0.1:54321"
    assert settings.r2_bucket == "audiotruyen"
    assert settings.supabase_service_role_key.get_secret_value() == "service-key"


def test_secrets_are_masked_in_repr(env):
    text = repr(load_settings(_env_file=None))
    assert "service-key" not in text
    assert "r2-hidden-value" not in text


def test_r2_endpoint_defaults_to_account_url(env):
    assert load_settings(_env_file=None).r2_endpoint == "https://acc123.r2.cloudflarestorage.com"


def test_r2_endpoint_override(env):
    env.setenv("R2_ENDPOINT_URL", "http://localhost:9000")
    assert load_settings(_env_file=None).r2_endpoint == "http://localhost:9000"


def test_worker_id_defaults_to_hostname(env):
    assert load_settings(_env_file=None).worker_id


def test_missing_required_value_fails(env):
    env.delenv("R2_BUCKET")
    with pytest.raises(ValidationError):
        load_settings(_env_file=None)


def test_validation_error_hides_secret_values(env):
    # pydantic middle-truncates input_value, so put a canary at the tail of the input
    # dict (R2_SECRET_ACCESS_KEY, last provided field) as well as in the middle.
    env.setenv("SUPABASE_SERVICE_ROLE_KEY", "leak-canary-123")
    env.setenv("R2_SECRET_ACCESS_KEY", "leak-canary-456")
    env.delenv("R2_BUCKET")
    with pytest.raises(ValidationError) as excinfo:
        load_settings(_env_file=None)
    message = str(excinfo.value)
    assert "leak-canary-123" not in message
    assert "leak-canary-456" not in message
