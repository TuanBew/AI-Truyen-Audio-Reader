"""Owner account management with the service-role client (single-user app)."""

from __future__ import annotations

MIN_PASSWORD_LENGTH = 12


def validate_password(password: str) -> None:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"password must be at least {MIN_PASSWORD_LENGTH} characters")


def create_owner(client, email: str, password: str) -> str:
    validate_password(password)
    response = client.auth.admin.create_user(
        {"email": email, "password": password, "email_confirm": True}
    )
    return response.user.id


def _find_user_id(client, email: str) -> str:
    page = 1
    while True:
        users = client.auth.admin.list_users(page=page, per_page=200)
        if not users:
            raise LookupError(f"no user with email {email}")
        for user in users:
            if (user.email or "").lower() == email.lower():
                return user.id
        page += 1


def set_password(client, email: str, password: str) -> str:
    validate_password(password)
    user_id = _find_user_id(client, email)
    client.auth.admin.update_user_by_id(user_id, {"password": password})
    return user_id
