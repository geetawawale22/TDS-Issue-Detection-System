"""Email delivery helpers used by authentication flows."""

import os
import smtplib
import ssl
from email.message import EmailMessage


def send_invite_email(recipient: str, full_name: str, invite_token: str) -> None:
    """Send the 'set your password' link to a newly created user.

    Required environment variables: same as send_password_reset_email.
    """
    smtp_host = os.getenv("SMTP_HOST")
    smtp_port = int(os.getenv("SMTP_PORT", "587"))
    smtp_from = os.getenv("SMTP_FROM") or os.getenv("EMAIL_FROM")
    smtp_username = os.getenv("SMTP_USERNAME") or os.getenv("SMTP_USER")
    smtp_password = os.getenv("SMTP_PASSWORD")
    use_tls = os.getenv("SMTP_USE_TLS", "true").lower() == "true"
    invite_expiry_hours = os.getenv("INVITE_EXPIRE_HOURS", "48")

    if not all((smtp_host, smtp_from, smtp_username, smtp_password)):
        raise RuntimeError("SMTP is not configured for invite emails")

    frontend_url = os.getenv("FRONTEND_URL", "http://localhost:5173").rstrip("/")
    invite_url = f"{frontend_url}/set-password/{invite_token}"

    message = EmailMessage()
    message["Subject"] = "You've been added to TDS Issue Detection System"
    message["From"] = smtp_from
    message["To"] = recipient
    message.set_content(
        f"Hi {full_name},\n\n"
        "You've been given access to the TDS Issue Detection System.\n\n"
        f"Set your password to activate your account: {invite_url}\n\n"
        f"This link expires in {invite_expiry_hours} hours. "
        "If you were not expecting this, please contact your administrator."
    )

    with smtplib.SMTP(smtp_host, smtp_port, timeout=15) as smtp:
        if use_tls:
            smtp.starttls(context=ssl.create_default_context())
        smtp.login(smtp_username, smtp_password)
        smtp.send_message(message)


def send_password_reset_email(recipient: str, reset_token: str) -> None:
    """Send the password-reset link using the configured SMTP relay.

    Required environment variables: SMTP_HOST, SMTP_PORT, SMTP_FROM,
    SMTP_USERNAME and SMTP_PASSWORD. Set SMTP_USE_TLS=false only when the
    relay does not support STARTTLS.
    """
    smtp_host = os.getenv("SMTP_HOST")
    smtp_port = int(os.getenv("SMTP_PORT", "587"))
    # EMAIL_FROM and SMTP_USER are the names used by the existing project
    # environment file. The SMTP_* aliases keep the service portable.
    smtp_from = os.getenv("SMTP_FROM") or os.getenv("EMAIL_FROM")
    smtp_username = os.getenv("SMTP_USERNAME") or os.getenv("SMTP_USER")
    smtp_password = os.getenv("SMTP_PASSWORD")
    use_tls = os.getenv("SMTP_USE_TLS", "true").lower() == "true"
    reset_expiry_minutes = os.getenv("PASSWORD_RESET_EXPIRE_MINUTES", "30")

    if not all((smtp_host, smtp_from, smtp_username, smtp_password)):
        raise RuntimeError("SMTP is not configured for password-reset emails")

    frontend_url = os.getenv("FRONTEND_URL", "http://localhost:5173").rstrip("/")
    reset_url = f"{frontend_url}/reset-password/{reset_token}"

    message = EmailMessage()
    message["Subject"] = "Reset your TDS Intelligence password"
    message["From"] = smtp_from
    message["To"] = recipient
    message.set_content(
        "A password reset was requested for your TDS Intelligence account.\n\n"
        f"Reset your password: {reset_url}\n\n"
        f"This link expires in {reset_expiry_minutes} minutes. "
        "If you did not request it, you can ignore this email."
    )

    with smtplib.SMTP(smtp_host, smtp_port, timeout=15) as smtp:
        if use_tls:
            smtp.starttls(context=ssl.create_default_context())
        smtp.login(smtp_username, smtp_password)
        smtp.send_message(message)
