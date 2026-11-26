"""Rows of a large SAP pull saved for the Issues page (services/upload_rows.py)."""

import json

from services.upload_rows import build_upload_rows, display_issue_type, section_aliases


def _row(index, status, **extra):
    return {
        "id": f"{status}:{index}", "rowIndex": index, "status": status, "docNo": f"D{index}",
        "docType": "kr", "vendor": "Acme", "vendorId": "V1", "vendorPan": "ABCDE1234F",
        "section": "194C", "baseAmount": 1000.0, "tdsAmount": 10.0, "companyCode": "1001",
        "date": "2026-07-01", **extra,
    }


def test_rows_pair_their_issues_and_get_ids_unique_across_batches():
    rows = [_row(1, "issue", reportCategory="short"), _row(2, "passed")]
    issues = [{"id": "UPL-000001", "rowIndex": 1, "category": "Short TDS Deducted — Amount Mismatch", "severity": "high", "status": "open"}]
    first = build_upload_rows(7, 1, rows, issues)
    second = build_upload_rows(7, 3, rows, issues)  # next batch numbers its rows from 1 again
    ids = [json.loads(m["data"])["id"] for m in first + second]
    assert len(set(ids)) == 4
    saved = json.loads(second[0]["data"])
    assert saved["rowIndex"] == 3 and saved["issues"][0]["rowIndex"] == 3
    assert saved["issues"][0]["id"] == "R7-3-1"
    assert second[0]["issue_tab"] == "short"
    assert second[0]["issue_severities"] == "|high|"
    assert "|Short TDS Deducted — Amount Mismatch|" in second[0]["issue_types"]
    assert first[1]["issue_tab"] is None and first[1]["issue_types"] is None
    assert first[0]["doc_type"] == "KR" and first[0]["tds_deducted"] is True


def test_zero_base_reads_as_insufficient_like_the_page():
    rows = [
        _row(1, "passed", baseAmount=0),
        _row(2, "passed", baseAmount=0, ldcCertificate="C1", ldcExemptionPercent=100),
        _row(3, "skipped", baseAmount=0),
        _row(4, "corrected", baseAmount=0),
    ]
    statuses = [m["status"] for m in build_upload_rows(1, 1, rows, [])]
    assert statuses == ["insufficient", "passed", "skipped", "insufficient"]


def test_section_keys_hold_old_and_new_act_names():
    assert section_aliases("194C") == {"194C", "393(1)6(I)"}
    mapping = build_upload_rows(1, 1, [_row(1, "passed", section="—")], [])[0]
    assert mapping["has_section"] is False


def test_amount_mismatch_shows_its_direction():
    issue = {"category": "Short/Excess TDS Deducted — Amount Mismatch", "baseAmount": 1000, "appliedRate": 2, "tdsAmount": 5}
    assert display_issue_type(issue) == "Short TDS Deducted — Amount Mismatch"
    assert display_issue_type({"category": "LDC Expired"}) == "LDC Out of Date"
