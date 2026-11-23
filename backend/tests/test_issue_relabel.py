"""A later run that only renames a line's issue keeps it open (services/issue_tracker.py)."""
from services.issue_tracker import _RELABEL_FIELDS, _relabelled_issues


def _entry(key, doc, line="1", category="TDS Not Deducted — Amount Zero"):
    row = {field: None for field in _RELABEL_FIELDS}
    row.update({"issue_key": key, "company_code": "1001", "fiscal_year": "2026", "doc_no": doc, "line_item": line, "category": category})
    return row


def _saved(row_id, key, doc, line="1"):
    return {"id": row_id, "issue_key": key, "company_code": "1001", "fiscal_year": "2026", "doc_no": doc, "line_item": line, "status": "open"}


def test_renamed_issue_on_same_line_is_kept_open():
    current = {"new": _entry("new", "A")}
    existing = {}
    carried = {"old": _saved(7, "old", "A")}
    updates = _relabelled_issues(current, existing, carried)
    assert carried == {}
    assert existing["new"]["id"] == 7
    assert updates == [{"id": 7, **{field: current["new"][field] for field in _RELABEL_FIELDS}}]
    assert updates[0]["issue_key"] == "new"


def test_other_lines_and_ambiguous_lines_are_not_renamed():
    current = {
        "new-b": _entry("new-b", "B"),
        "new-c1": _entry("new-c1", "C", category="X"),
        "new-c2": _entry("new-c2", "C", category="Y"),
    }
    carried = {"old-a": _saved(1, "old-a", "A"), "old-c": _saved(3, "old-c", "C")}
    existing = {}
    assert _relabelled_issues(current, existing, carried) == []
    assert set(carried) == {"old-a", "old-c"}
    assert existing == {}


def test_issue_raised_again_under_same_key_is_not_a_rename():
    current = {"same": _entry("same", "A"), "extra": _entry("extra", "A", category="X")}
    existing = {"same": _saved(5, "same", "A")}
    carried = {}
    assert _relabelled_issues(current, existing, carried) == []
