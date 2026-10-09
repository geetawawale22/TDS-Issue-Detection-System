import os

from sqlalchemy import or_

from core.security import hash_password
from db.database import SessionLocal
from db.models import User


DEFAULT_ADMIN_EMAIL = "samrudhi.neve@kriosispl.com"
DEFAULT_ADMIN_PASSWORD = "Admin@123"
DEFAULT_ADMIN_USERNAME = "admin"
DEFAULT_ADMIN_FULL_NAME = "System Administrator"


def seed_admin():
    """
    Creates a bootstrap admin user if the database does not have one.

    Safe to run on an existing setup:
    - if any active admin already exists, nothing is changed
    - if the configured email/username exists, that user is made admin/active
    - otherwise a new admin user is created

    Optional environment variables:
    - BOOTSTRAP_ADMIN_EMAIL
    - BOOTSTRAP_ADMIN_PASSWORD
    - BOOTSTRAP_ADMIN_USERNAME
    - BOOTSTRAP_ADMIN_FULL_NAME
    """

    admin_email = os.getenv("BOOTSTRAP_ADMIN_EMAIL", DEFAULT_ADMIN_EMAIL).strip().lower()
    admin_password = os.getenv("BOOTSTRAP_ADMIN_PASSWORD", DEFAULT_ADMIN_PASSWORD)
    admin_username = os.getenv("BOOTSTRAP_ADMIN_USERNAME", DEFAULT_ADMIN_USERNAME).strip()
    admin_full_name = os.getenv("BOOTSTRAP_ADMIN_FULL_NAME", DEFAULT_ADMIN_FULL_NAME).strip()

    if not admin_email or not admin_password or not admin_username:
        raise ValueError("Admin email, username, and password are required.")

    db = SessionLocal()

    try:
        active_admin = (
            db.query(User)
            .filter(User.role == "admin", User.is_active.is_(True))
            .first()
        )

        if active_admin:
            print(f"Active admin already exists: {active_admin.email}")
            return

        existing_admin = (
            db.query(User)
            .filter(or_(User.email == admin_email, User.username == admin_username))
            .first()
        )

        if existing_admin:
            existing_admin.full_name = existing_admin.full_name or admin_full_name
            existing_admin.email = admin_email
            existing_admin.username = admin_username
            existing_admin.hashed_password = hash_password(admin_password)
            existing_admin.role = "admin"
            existing_admin.is_active = True
            db.commit()
            print(f"Existing user promoted to active admin: {admin_email}")
            return

        admin = User(
            username=admin_username,
            full_name=admin_full_name,
            email=admin_email,
            hashed_password=hash_password(admin_password),
            role="admin",
            is_active=True,
            created_by=None
        )

        db.add(admin)
        db.commit()

        print(f"Admin user created successfully: {admin_email}")

    except Exception as e:
        db.rollback()
        print(f"Error: {e}")

    finally:
        db.close()


if __name__ == "__main__":
    seed_admin()
