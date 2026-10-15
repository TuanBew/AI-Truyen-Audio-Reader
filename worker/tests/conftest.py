import os
import secrets
import uuid

import pytest

URL = os.environ.get("TEST_SUPABASE_URL")
ANON = os.environ.get("TEST_SUPABASE_ANON_KEY")
SERVICE = os.environ.get("TEST_SUPABASE_SERVICE_ROLE_KEY")


def _require_db():
    if not (URL and ANON and SERVICE):
        pytest.skip("local Supabase not configured; run scripts/supabase-test-env.sh")


@pytest.fixture
def admin_client():
    _require_db()
    from supabase import create_client

    return create_client(URL, SERVICE)


@pytest.fixture
def owner(admin_client):
    from audiotruyen_worker.admin import create_owner

    email = f"owner-{uuid.uuid4().hex[:10]}@audiotruyen.test"
    password = secrets.token_urlsafe(18)
    user_id = create_owner(admin_client, email, password)
    yield {"id": user_id, "email": email, "password": password}
    admin_client.auth.admin.delete_user(user_id)
