"""
PAN Verification Service — Government PAN status check.

The Government PAN verification API has not been provided yet. Until it is,
every well-formed PAN comes back as NOT_VERIFIED (only the format was
checked), so nothing is wrongly flagged under Section 206AA.

TO CONNECT THE REAL API — replace every "xxxxx" below:
  1. backend/.env:
       PAN_VERIFICATION_API_URL=xxxxx   -> the API endpoint URL
       PAN_VERIFICATION_API_KEY=xxxxx   -> the API key / token
  2. The API_* constants in this file -> the field names and status codes
     from the API documentation.
  3. If the API needs a different request (GET, a signed payload, a DSC
     certificate, ...), adjust _call_real_api() — nothing else changes.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Any, Optional

import requests


# ---------------------------------------------------------------------------
# Status codes stored in pan_verifications.status and used by the UI.
# ---------------------------------------------------------------------------
VERIFIED = "VERIFIED"              # PAN exists and is operative
INVALID = "INVALID"                # PAN does not exist as per the Government API
INOPERATIVE = "INOPERATIVE"        # PAN exists but is inoperative (e.g. not Aadhaar-linked)
INVALID_FORMAT = "INVALID_FORMAT"  # fails AAAAA9999A — never sent to the API
NOT_VERIFIED = "NOT_VERIFIED"      # API not configured, only the format was checked
ERROR = "ERROR"                    # the API call failed

# Statuses that make Section 206AA apply (treated the same as a missing PAN).
PAN_FAILURE_STATUSES = {INVALID, INOPERATIVE, INVALID_FORMAT}

PAN_FORMAT_REGEX = re.compile(r"^[A-Z]{5}[0-9]{4}[A-Z]$")

# Value used in .env until the real API details arrive.
PLACEHOLDER = "xxxxx"


# ---------------------------------------------------------------------------
# Government API contract — REPLACE "xxxxx" WITH VALUES FROM THE API DOCS.
# ---------------------------------------------------------------------------
API_AUTH_HEADER = "xxxxx"              # header carrying the key, e.g. "Authorization" / "x-api-key"
API_AUTH_PREFIX = "xxxxx"              # e.g. "Bearer " — set to "" if the key is sent as-is
API_REQUEST_PAN_FIELD = "xxxxx"        # request body field holding the PAN, e.g. "pan"
API_RESPONSE_STATUS_FIELD = "xxxxx"    # response field holding the PAN status, e.g. "pan_status"
API_RESPONSE_NAME_FIELD = "xxxxx"      # response field holding the name on PAN (used later for name match)
API_TIMEOUT_SECONDS = 15

# Maps the API's own status codes to ours. Typical NSDL/Protean codes are
# E = existing & valid, F = fake, X = deactivated, N = not found — confirm
# against the real documentation before relying on them.
API_STATUS_MAP = {
    "xxxxx_valid": VERIFIED,
    "xxxxx_invalid": INVALID,
    "xxxxx_inoperative": INOPERATIVE,
}


@dataclass
class PANVerificationResult:
    pan: str
    status: str
    source: str                           # "api" | "format_check"
    name_on_record: Optional[str] = None  # reserved for the later name-match check
    message: Optional[str] = None


def normalise_pan(value: Any) -> str:
    return str(value or "").strip().upper()


def is_valid_pan_format(pan: Any) -> bool:
    return bool(PAN_FORMAT_REGEX.match(normalise_pan(pan)))


def _is_set(value: Optional[str]) -> bool:
    return bool(value) and value.strip().lower() != PLACEHOLDER


class PANVerificationService:
    # Read on use rather than at import, so the order in which modules load
    # .env never matters.
    @property
    def api_url(self) -> str:
        return os.getenv("PAN_VERIFICATION_API_URL", "")

    @property
    def api_key(self) -> str:
        return os.getenv("PAN_VERIFICATION_API_KEY", "")

    @property
    def is_configured(self) -> bool:
        """True once real (non-"xxxxx") API URL and key are in .env."""
        return _is_set(self.api_url) and _is_set(self.api_key)

    def verify_pan(self, pan: str) -> PANVerificationResult:
        pan = normalise_pan(pan)

        if not is_valid_pan_format(pan):
            return PANVerificationResult(
                pan=pan,
                status=INVALID_FORMAT,
                source="format_check",
                message="PAN does not match the AAAAA9999A format.",
            )

        if not self.is_configured:
            return PANVerificationResult(
                pan=pan,
                status=NOT_VERIFIED,
                source="format_check",
                message="Government PAN API not configured yet — only the format was checked.",
            )

        try:
            return self._call_real_api(pan)
        except Exception as exc:  # network error, bad response, unmapped status...
            return PANVerificationResult(
                pan=pan,
                status=ERROR,
                source="api",
                message=f"PAN verification API call failed: {exc}",
            )

    def _call_real_api(self, pan: str) -> PANVerificationResult:
        """
        Calls the Government PAN verification API for one PAN.
        Adjust the request below if the API documentation differs.
        """
        response = requests.post(
            self.api_url,
            json={API_REQUEST_PAN_FIELD: pan},
            headers={API_AUTH_HEADER: f"{API_AUTH_PREFIX}{self.api_key}"},
            timeout=API_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        payload = response.json()

        api_status = str(payload.get(API_RESPONSE_STATUS_FIELD, "")).strip()
        status = API_STATUS_MAP.get(api_status)
        if status is None:
            raise ValueError(f"unrecognised PAN status '{api_status}' from the API")

        return PANVerificationResult(
            pan=pan,
            status=status,
            source="api",
            name_on_record=payload.get(API_RESPONSE_NAME_FIELD),
            message=f"Government API status: {api_status}",
        )


# Singleton instance — reused across the application
pan_verification_service = PANVerificationService()
