"""Correction rows are labelled by where their original document stands now."""
from types import SimpleNamespace

from api.issues import correction_original_status


def _issue(status, correction_docs=None, remaining_shortfall=None):
    return SimpleNamespace(status=status, correction_docs=correction_docs, remaining_shortfall=remaining_shortfall)


def test_every_issue_resolved_means_original_resolved():
    assert correction_original_status([_issue("resolved"), _issue("resolved")]) == "resolved"


def test_open_issue_with_a_correction_applied_is_partly_corrected():
    issues = [_issue("resolved"), _issue("open", correction_docs='[{"docNo": "1009700002"}]', remaining_shortfall=120.0)]
    assert correction_original_status(issues) == "partial"


def test_open_issue_without_any_correction_is_still_open():
    assert correction_original_status([_issue("open")]) == "open"


def test_original_without_saved_issue_has_no_status():
    assert correction_original_status([]) is None
