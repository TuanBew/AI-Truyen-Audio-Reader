"""Supabase client with the service-role key (bypasses RLS; worker only)."""

from __future__ import annotations

from supabase import Client, create_client

from audiotruyen_worker.config import Settings


def make_client(settings: Settings) -> Client:
    return create_client(
        settings.supabase_url, settings.supabase_service_role_key.get_secret_value()
    )
