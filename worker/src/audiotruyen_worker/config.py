"""Worker configuration from environment variables and worker/.env."""

from __future__ import annotations

import socket

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        hide_input_in_errors=True,  # never echo env values (secrets) in validation errors
    )

    supabase_url: str
    supabase_service_role_key: SecretStr
    r2_account_id: str
    r2_access_key_id: str
    r2_secret_access_key: SecretStr
    r2_bucket: str
    r2_endpoint_url: str | None = None
    worker_id: str = Field(default_factory=socket.gethostname)
    log_level: str = "INFO"

    @property
    def r2_endpoint(self) -> str:
        return self.r2_endpoint_url or f"https://{self.r2_account_id}.r2.cloudflarestorage.com"


def load_settings(**overrides) -> Settings:
    return Settings(**overrides)
