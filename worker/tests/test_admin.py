import pytest

from audiotruyen_worker.admin import validate_password


def test_short_password_rejected():
    with pytest.raises(ValueError):
        validate_password("short")


def test_long_password_accepted():
    validate_password("đủ-dài-để-dùng-123")


@pytest.mark.db
def test_created_owner_can_sign_in(owner):
    from supabase import create_client

    from tests.conftest import ANON, URL

    anon = create_client(URL, ANON)
    session = anon.auth.sign_in_with_password(
        {"email": owner["email"], "password": owner["password"]}
    )
    assert session.user.id == owner["id"]


@pytest.mark.db
def test_set_password_changes_login(admin_client, owner):
    from supabase import create_client

    from audiotruyen_worker.admin import set_password
    from tests.conftest import ANON, URL

    set_password(admin_client, owner["email"], "mat-khau-moi-rat-dai-42")
    anon = create_client(URL, ANON)
    session = anon.auth.sign_in_with_password(
        {"email": owner["email"], "password": "mat-khau-moi-rat-dai-42"}
    )
    assert session.user.id == owner["id"]


@pytest.mark.db
def test_set_password_unknown_email(admin_client):
    from audiotruyen_worker.admin import set_password

    with pytest.raises(LookupError):
        set_password(admin_client, "khong-ton-tai@audiotruyen.test", "mat-khau-moi-rat-dai-42")
