"""SAP data API client: request shape, rows/meta, and readable errors (no network)."""
import pytest
import requests

from services import sap_data_api
from services.sap_data_api import SapDataApiError


class _Response:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload
        self.text = text

    def json(self):
        if self._payload is None:
            raise ValueError("not json")
        return self._payload


@pytest.fixture(autouse=True)
def _configured(monkeypatch):
    monkeypatch.setenv("SAP_DATA_API_URL", "https://bigqueryapi.example.test/query")
    monkeypatch.setenv("SAP_DATA_API_TOKEN", "Bearer secret-token")


def test_query_sends_table_paging_and_conditions_with_bearer_token(monkeypatch):
    sent = {}

    def fake_post(url, json, headers, timeout):
        sent.update(url=url, json=json, headers=headers)
        return _Response(payload={"data": [{"Company_Code": "1001", "Supplier": "BAL041"}], "totalCount": 1})

    monkeypatch.setattr(sap_data_api.requests, "post", fake_post)
    page = sap_data_api.query("ZAPI_TDS_EXEMPTION", 2, 500, "Company_Code = '1001'")

    assert sent["json"] == {
        "Table_View_Name": "ZAPI_TDS_EXEMPTION", "PageNo": 2, "PageSize": 500,
        "otherConditions": "Company_Code = '1001'",
    }
    # Pasted with "Bearer " — sent once, not twice.
    assert sent["headers"]["Authorization"] == "Bearer secret-token"
    assert page.rows == [{"Company_Code": "1001", "Supplier": "BAL041"}]
    assert page.meta == {"totalCount": 1}


def test_unresolvable_host_says_to_use_the_vpn(monkeypatch):
    def fake_post(*args, **kwargs):
        raise requests.exceptions.ConnectionError("Failed to resolve 'bigqueryapi.example.test' (Name or service not known)")

    monkeypatch.setattr(sap_data_api.requests, "post", fake_post)
    with pytest.raises(SapDataApiError, match="VPN"):
        sap_data_api.query("ZAPI_TDS_EXEMPTION")


def test_rejected_token_is_reported(monkeypatch):
    monkeypatch.setattr(sap_data_api.requests, "post", lambda *a, **k: _Response(status_code=401, text="Unauthorized"))
    with pytest.raises(SapDataApiError, match="token") as error:
        sap_data_api.query("ZAPI_TDS_EXEMPTION")
    assert error.value.status_code == 401


def test_not_configured_does_not_call_the_api(monkeypatch):
    monkeypatch.setenv("SAP_DATA_API_TOKEN", "")
    monkeypatch.setattr(sap_data_api.requests, "post", lambda *a, **k: pytest.fail("must not call the API"))
    with pytest.raises(SapDataApiError, match="not configured"):
        sap_data_api.query("ZAPI_TDS_EXEMPTION")
    assert sap_data_api.config() == {"url": "https://bigqueryapi.example.test/query", "configured": False}
