"""
PAN Verification Service — Government PAN status check.

Currently running in MOCK MODE since Mahindra has not yet provided
API credentials for the government PAN verification service
(typically NSDL/Protean eGov PAN Verification API, or a similar
provider Mahindra's compliance team already uses).

Once credentials are available, only PANVerificationService._call_real_api()
needs to be implemented — everything else (caching, response shape,
integration into the rule engine) is already built and ready.
"""

import os
from typing import Optional
from datetime import datetime, timezone
from dataclasses import dataclass


@dataclass
class PANVerificationResult:
    pan: str
    is_valid_format: bool
    status: Optional[str] = None          # "Active" / "Inactive" / "Deactivated" / None if unchecked
    name_on_record: Optional[str] = None  # name registered against this PAN, for name-match checks
    aadhaar_linked: Optional[bool] = None
    checked_at: Optional[datetime] = None
    is_mocked: bool = True                # False once real API is wired in
    error: Optional[str] = None


class PANVerificationService:
    """
    Wraps government PAN verification. Falls back to MOCK MODE
    automatically if credentials aren't configured — so the rest
    of the system can be built and tested without waiting on
    Mahindra's API access.
    """

    def __init__(self):
        self.api_key = os.getenv("PAN_VERIFICATION_API_KEY")
        self.api_url = os.getenv("PAN_VERIFICATION_API_URL")
        self.is_configured = bool(self.api_key and self.api_url)

    def verify_pan(self, pan: str) -> PANVerificationResult:
        """
        Main entry point. Returns mock result until real credentials
        are configured in .env (PAN_VERIFICATION_API_KEY, PAN_VERIFICATION_API_URL).
        """
        from rules.tds_rule_engine import _is_valid_pan_format

        if not _is_valid_pan_format(pan):
            return PANVerificationResult(
                pan=pan,
                is_valid_format=False,
                status="Invalid Format",
                is_mocked=not self.is_configured,
            )

        if not self.is_configured:
            return self._mock_response(pan)

        return self._call_real_api(pan)

    def _mock_response(self, pan: str) -> PANVerificationResult:
        """
        MOCK MODE. Always returns 'Active' with is_mocked=True, so
        downstream code can clearly tell this result is NOT a real
        government verification — just a placeholder confirming the
        PAN is well-formed.
        """
        return PANVerificationResult(
            pan=pan,
            is_valid_format=True,
            status="Active",
            name_on_record=None,
            aadhaar_linked=None,
            checked_at=datetime.now(timezone.utc),
            is_mocked=True,
        )

    def _call_real_api(self, pan: str) -> PANVerificationResult:
        """
        PLACEHOLDER — implement once Mahindra provides API credentials.

        Typical NSDL/Protean-style PAN Verification API request/response:
          Request:  { "pan": "AAACE6641E" }
          Response: { "pan_status": "E", "name_pan": "...", "aadhaar_seeded": "Y/N" }
          Status codes commonly used: E = Existing & Valid, D = Deactivated,
          F = Fake/Invalid.

        Replace this function body with the real HTTP call once the
        exact provider and API contract are confirmed by Mahindra.
        """
        raise NotImplementedError(
            "Real PAN verification API not yet configured. "
            "Set PAN_VERIFICATION_API_KEY and PAN_VERIFICATION_API_URL "
            "in .env once Mahindra provides credentials, then implement "
            "the actual HTTP call in this function."
        )


# Singleton instance — reused across the application
pan_verification_service = PANVerificationService()