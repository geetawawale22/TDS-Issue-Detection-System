"""Mahindra SAP data API (BigQuery query service) — read SAP tables directly.

One endpoint, POST {SAP_DATA_API_URL} with a bearer token, body:

    {"Table_View_Name": "ZAPI_TDS_EXEMPTION", "PageNo": 1, "PageSize": 1000,
     "otherConditions": "Company_Code = '1001'"}

and the rows come back under "data". ``otherConditions`` is the API's own
filter (a SQL-style condition). The URL and token live in backend/.env:

    SAP_DATA_API_URL=https://bigqueryapi.m-devsecops.com/query
    SAP_DATA_API_TOKEN=<bearer token>

The token never leaves the backend. The host is only reachable from
Mahindra's network (VPN); elsewhere its name does not resolve.

For now this only fetches and returns rows so their structure can be
checked (Settings → SAP Data API). Mapping them into LDC Master or the
TDS analysis comes once the structure is confirmed; Excel uploads stay.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from typing import Any

import requests

TIMEOUT_SECONDS = 60
# Largest page we ask the API for; it may cap pages lower itself.
MAX_PAGE_SIZE = 5000
# Error bodies are shown to the admin; keep them short.
_ERROR_BODY_LIMIT = 500


class SapDataApiError(Exception):
    """The call failed; ``message`` says why in plain words for the UI."""

    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


@dataclass
class SapPage:
    rows: list[dict[str, Any]]
    # Top-level response fields other than "data" (e.g. a total count), as sent.
    meta: dict[str, Any] = field(default_factory=dict)
    elapsed_ms: int = 0


def _url() -> str:
    return (os.getenv("SAP_DATA_API_URL") or "").strip()


def _token() -> str:
    token = (os.getenv("SAP_DATA_API_TOKEN") or "").strip()
    # Accept the token pasted with or without its "Bearer " prefix.
    return token[7:].strip() if token.lower().startswith("bearer ") else token


def config() -> dict[str, Any]:
    """What the UI may know about the connection (never the token)."""
    return {"url": _url() or None, "configured": bool(_url() and _token())}


def _reason(exc: Exception) -> str:
    """The underlying cause from a requests error, kept short, never showing the token."""
    text = str(exc).strip()
    if _token():
        text = text.replace(_token(), "***")
    return text[-300:]


def _host() -> str:
    return requests.utils.urlparse(_url()).hostname or _url()


def query(table: str, page_no: int = 1, page_size: int = 1000, other_conditions: str = "") -> SapPage:
    """One page of ``table``. Raises SapDataApiError with a readable reason."""
    if not _url() or not _token():
        raise SapDataApiError("SAP data API is not configured: set SAP_DATA_API_URL and SAP_DATA_API_TOKEN in backend/.env.")
    body = {
        "Table_View_Name": table,
        "PageNo": page_no,
        "PageSize": page_size,
        "otherConditions": other_conditions or "",
    }
    started = time.monotonic()
    try:
        response = requests.post(
            _url(),
            json=body,
            headers={"Authorization": f"Bearer {_token()}", "Accept": "application/json"},
            timeout=TIMEOUT_SECONDS,
        )
    # SSLError and ProxyError are ConnectionErrors too, so they are caught first.
    except requests.exceptions.SSLError as exc:
        raise SapDataApiError(
            f"SSL certificate check failed for {_host()}. The company network re-signs HTTPS traffic: install "
            "pip-system-certs in the backend venv (python -m pip install pip-system-certs) or set "
            f"REQUESTS_CA_BUNDLE in backend/.env to the company root certificate, then restart the backend. ({_reason(exc)})"
        ) from exc
    except requests.exceptions.ProxyError as exc:
        raise SapDataApiError(f"The network proxy refused the call to {_host()}. Check the proxy settings with IT. ({_reason(exc)})") from exc
    except requests.exceptions.ConnectionError as exc:
        text = str(exc).lower()
        if "resolve" in text or "getaddrinfo" in text or "name or service not known" in text:
            raise SapDataApiError(
                f"Cannot find the API server {_host()}. It is only reachable from Mahindra's network — "
                "connect to the Mahindra VPN on the machine running the backend and try again."
            ) from exc
        raise SapDataApiError(f"Cannot connect to the API server {_host()}: the connection was refused or dropped. ({_reason(exc)})") from exc
    except requests.exceptions.Timeout as exc:
        raise SapDataApiError(f"The API did not answer within {TIMEOUT_SECONDS} seconds. Try a smaller page size.") from exc
    except requests.exceptions.RequestException as exc:
        raise SapDataApiError(f"The API call failed: {exc.__class__.__name__}.") from exc
    elapsed_ms = int((time.monotonic() - started) * 1000)

    if response.status_code in (401, 403):
        raise SapDataApiError(
            f"The API rejected the token ({response.status_code}). Check SAP_DATA_API_TOKEN in backend/.env — it may have expired.",
            response.status_code,
        )
    if response.status_code >= 400:
        raise SapDataApiError(
            f"The API returned {response.status_code}: {response.text[:_ERROR_BODY_LIMIT]}",
            response.status_code,
        )
    try:
        payload = response.json()
    except ValueError as exc:
        raise SapDataApiError(f"The API did not return JSON: {response.text[:_ERROR_BODY_LIMIT]}") from exc

    if isinstance(payload, list):
        return SapPage(rows=[row for row in payload if isinstance(row, dict)], elapsed_ms=elapsed_ms)
    if not isinstance(payload, dict):
        raise SapDataApiError("The API returned JSON in an unexpected shape (neither a list nor an object).")
    rows = payload.get("data")
    if rows is None:
        rows = []
    if not isinstance(rows, list):
        raise SapDataApiError('The API response has a "data" field that is not a list.')
    meta = {key: value for key, value in payload.items() if key != "data"}
    return SapPage(rows=[row for row in rows if isinstance(row, dict)], meta=meta, elapsed_ms=elapsed_ms)
