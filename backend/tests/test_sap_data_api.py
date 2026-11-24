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


def test_certificate_failure_is_not_reported_as_a_refused_connection(monkeypatch):
    def fake_post(*args, **kwargs):
        raise requests.exceptions.SSLError("certificate verify failed: self-signed certificate in certificate chain")

    monkeypatch.setattr(sap_data_api.requests, "post", fake_post)
    with pytest.raises(SapDataApiError, match="SSL certificate check failed") as error:
        sap_data_api.query("ZAPI_TDS_EXEMPTION")
    assert "pip-system-certs" in error.value.message
    assert "self-signed certificate" in error.value.message


def test_fetch_all_reads_pages_until_a_short_page(monkeypatch):
    pages = {1: [{"n": 1}, {"n": 2}], 2: [{"n": 3}, {"n": 4}], 3: [{"n": 5}]}
    asked = []

    def fake_query(table, page_no, page_size, other_conditions):
        asked.append((page_no, other_conditions))
        return sap_data_api.SapPage(rows=pages[page_no])

    monkeypatch.setattr(sap_data_api, "query", fake_query)
    rows = sap_data_api.fetch_all("ZAPI_TDS_VENDOR_ITEMS", "Company_Code = '1001'", page_size=2)
    assert [row["n"] for row in rows] == [1, 2, 3, 4, 5]
    assert asked == [(1, "Company_Code = '1001'"), (2, "Company_Code = '1001'"), (3, "Company_Code = '1001'")]


def test_fetch_all_stops_if_the_api_ignores_page_numbers(monkeypatch):
    monkeypatch.setattr(sap_data_api, "query", lambda *a: sap_data_api.SapPage(rows=[{"n": 1}, {"n": 2}]))
    assert len(sap_data_api.fetch_all("T", page_size=2)) == 2


def test_fetch_all_refuses_more_than_the_cap(monkeypatch):
    monkeypatch.setattr(sap_data_api, "query", lambda t, page_no, *a: sap_data_api.SapPage(rows=[{"n": page_no}, {"n": -page_no}]))
    with pytest.raises(SapDataApiError, match="Narrow them"):
        sap_data_api.fetch_all("T", page_size=2, max_rows=5)


def test_analyse_runs_api_rows_through_the_upload_analysis_and_saves_the_run(monkeypatch):
    import json

    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from api import sap_data
    from db.database import Base
    from db.models import RuleRun, User

    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    admin = User(full_name="Admin", username="admin", email="admin@example.test", role="admin", is_active=True)
    db.add(admin)
    db.commit()

    rows = [{
        "Company_Code": "1001", "Vendor_Code": "V001", "Vendor_Name": "Acme", "Document_No": "5100000001",
        "Posting_Date": "2026-10-05", "TDS_Section": "194C", "TDS_Rate": "2", "Basic_Amount": "100000",
        "TDS_Amount": "", "PAN": "ABCPE1234F",
    }]
    monkeypatch.setattr(sap_data.sap_data_api, "fetch_all", lambda table, conditions: rows)
    request = sap_data.FetchAllRequest(table="ZAPI_TDS_VENDOR_ITEMS", other_conditions="Company_Code = '1001'", company_code="1001")
    response = sap_data.analyse(request, current_user=admin, db=db)
    body = json.loads(response.body)

    assert body["stats"]["transactionsBuilt"] == 1
    assert body["fileName"] == "SAP API · ZAPI_TDS_VENDOR_ITEMS"
    run = db.query(RuleRun).one()
    assert run.source == "sap_api"
