"""Correction register: saving, reconciliation, undo, approval and legacy import."""

from decimal import Decimal

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from db.database import Base
from db.models import CorrectionGroup, TrackedIssue, User
from services.correction_register import (
    CorrectionError,
    create_group,
    group_amounts,
    group_to_dict,
    import_legacy_groups,
    review_group,
    undo_group,
)


@pytest.fixture()
def db():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


def _user(db, uid, role="accountant"):
    user = User(id=uid, full_name=f"User {uid}", username=f"u{uid}", email=f"u{uid}@example.com", role=role, is_active=True)
    db.add(user)
    db.commit()
    return user


def _tracked(db, key="K1", doc="3190025638", remaining=None):
    row = TrackedIssue(
        issue_key=key, company_code="1001", fiscal_year="2026", doc_no=doc, line_item="1",
        category="Wrong TDS rate", vendor_code="V1", vendor_name="Vendor One",
        base_amount=Decimal("100000"), tds_amount=Decimal("1000"), applied_rate=Decimal("1"),
        expected_rate=Decimal("2"), tax_impact=Decimal("1000"), status="open",
        remaining_shortfall=remaining,
    )
    db.add(row)
    db.commit()
    return row


ISSUE = {
    "issueKey": "K1", "companyCode": "1001", "fiscalYear": "2026", "docNo": "3190025638", "lineItem": "1",
    "category": "Wrong TDS rate", "vendor": "Vendor One", "vendorId": "V1", "section": "194C",
    "baseAmount": 100000, "appliedRate": 1, "expectedRate": 2, "tdsAmount": 1000, "taxImpact": 1000,
}


def _row(doc, role, tds):
    return {"docNo": doc, "role": role, "tdsAmount": tds, "companyCode": "1001", "fiscalYear": "2026", "lineItem": "1"}


def test_difference_only_resolves_tracked_issue_and_reconciles(db):
    maker = _user(db, 1)
    tracked = _tracked(db)
    group = create_group(db, maker, ISSUE, "DIFFERENCE_ONLY", None, [_row("5100000001", "ADDITIONAL_DEDUCTION", 1000)], tracked)

    assert group.group_code == f"CG-{group.id:05d}"
    amounts = group_amounts(group)
    assert amounts == {
        "appliedTdsAmount": 1000.0, "expectedTdsAmount": 2000.0, "requiredCorrection": 1000.0,
        "netAmount": 1000.0, "correctedTdsAmount": 2000.0, "unreconciledAmount": 0.0,
    }
    db.refresh(tracked)
    assert tracked.status == "resolved" and tracked.resolution_type == "MANUAL"
    assert group.company_code == "1001"


def test_full_reversal_uses_real_sap_amounts_not_calculated_ones(db):
    maker = _user(db, 1)
    # Reversal of ₹1,000 and fresh deduction of only ₹1,800 (₹200 still short).
    with pytest.raises(CorrectionError) as error:
        create_group(db, maker, ISSUE, "FULL_REVERSAL", "", [
            _row("5100000001", "REVERSAL", 1000), _row("5100000002", "FRESH_DEDUCTION", 1800),
        ], None)
    assert error.value.status_code == 422  # a difference needs a remark

    group = create_group(db, maker, ISSUE, "FULL_REVERSAL", "Balance ₹200 next month", [
        _row("5100000001", "REVERSAL", 1000), _row("5100000002", "FRESH_DEDUCTION", 1800),
    ], None)
    data = group_to_dict(group, {})
    assert data["netAmount"] == 800.0
    assert data["correctedTdsAmount"] == 1800.0
    assert data["unreconciledAmount"] == 200.0
    assert data["reconciled"] is False
    assert [entry["amount"] for entry in data["entries"]] == [-1000.0, 1800.0]


def test_second_active_group_for_same_issue_is_refused(db):
    maker = _user(db, 1)
    create_group(db, maker, ISSUE, "DIFFERENCE_ONLY", None, [_row("5100000001", "ADDITIONAL_DEDUCTION", 1000)], None)
    with pytest.raises(CorrectionError) as error:
        create_group(db, maker, ISSUE, "DIFFERENCE_ONLY", None, [_row("5100000009", "ADDITIONAL_DEDUCTION", 1000)], None)
    assert error.value.status_code == 409


def test_same_document_in_another_fiscal_year_is_a_different_issue(db):
    maker = _user(db, 1)
    create_group(db, maker, {**ISSUE, "issueKey": None}, "DIFFERENCE_ONLY", None, [_row("5100000001", "ADDITIONAL_DEDUCTION", 1000)], None)
    other_year = {**ISSUE, "issueKey": None, "fiscalYear": "2025"}
    group = create_group(db, maker, other_year, "DIFFERENCE_ONLY", None, [_row("5100000002", "ADDITIONAL_DEDUCTION", 1000)], None)
    assert group.fiscal_year == "2025"


def test_unknown_role_is_refused(db):
    maker = _user(db, 1)
    with pytest.raises(CorrectionError):
        create_group(db, maker, ISSUE, "DIFFERENCE_ONLY", None, [_row("5100000001", "SOMETHING", 1000)], None)


def test_undo_restores_previous_tracked_state(db):
    maker = _user(db, 1)
    tracked = _tracked(db, remaining=Decimal("400"))
    group = create_group(db, maker, ISSUE, "DIFFERENCE_ONLY", None, [_row("5100000001", "ADDITIONAL_DEDUCTION", 1000)], tracked)

    with pytest.raises(CorrectionError):
        undo_group(db, maker, group, "")  # reason required
    reopened = undo_group(db, maker, group, "Wrong rows")
    assert reopened is True
    db.refresh(tracked)
    assert tracked.status == "open"
    assert tracked.resolution_type is None
    assert tracked.remaining_shortfall == Decimal("400")
    assert group.status == "undone" and group.status_note == "Wrong rows"

    # Undone group no longer blocks a new match.
    create_group(db, maker, ISSUE, "DIFFERENCE_ONLY", None, [_row("5100000002", "ADDITIONAL_DEDUCTION", 1000)], tracked)


def test_only_maker_or_admin_can_undo(db):
    maker = _user(db, 1)
    other = _user(db, 2)
    group = create_group(db, maker, ISSUE, "DIFFERENCE_ONLY", None, [_row("5100000001", "ADDITIONAL_DEDUCTION", 1000)], None)
    with pytest.raises(CorrectionError) as error:
        undo_group(db, other, group, "not mine")
    assert error.value.status_code == 403


def test_maker_checker_approval(db):
    maker = _user(db, 1, role="admin")
    checker = _user(db, 2, role="admin")
    accountant = _user(db, 3)
    tracked = _tracked(db)
    group = create_group(db, maker, ISSUE, "DIFFERENCE_ONLY", None, [_row("5100000001", "ADDITIONAL_DEDUCTION", 1000)], tracked)

    with pytest.raises(CorrectionError):
        review_group(db, maker, group, approve=True, note=None)  # own match
    with pytest.raises(CorrectionError):
        review_group(db, accountant, group, approve=True, note=None)  # not admin
    review_group(db, checker, group, approve=True, note="ok")
    assert group.status == "approved"

    # Approved: only an admin may undo it.
    with pytest.raises(CorrectionError):
        undo_group(db, accountant, group, "x")


def test_reject_reopens_issue(db):
    maker = _user(db, 1)
    checker = _user(db, 2, role="admin")
    tracked = _tracked(db)
    group = create_group(db, maker, ISSUE, "DIFFERENCE_ONLY", None, [_row("5100000001", "ADDITIONAL_DEDUCTION", 1000)], tracked)
    with pytest.raises(CorrectionError):
        review_group(db, checker, group, approve=False, note="")  # reason required
    assert review_group(db, checker, group, approve=False, note="Rows belong to another invoice") is True
    db.refresh(tracked)
    assert tracked.status == "open"
    assert group.status == "rejected"


def test_legacy_import_runs_once_and_links_manual_issue(db):
    user = _user(db, 1)
    tracked = _tracked(db)
    tracked.status, tracked.resolution_type = "resolved", "MANUAL"
    db.commit()
    legacy = [{
        "groupId": "CG-0001", "originalDocumentNumber": "3190025638", "method": "DIFFERENCE_ONLY",
        "status": "matched_in_sap", "createdAt": "2026-11-10T10:00:00Z", "remarks": "old",
        "matchedBy": {"name": "Asha"},
        "entries": [{"correctionDocumentNumber": "5100000001", "role": "ADDITIONAL_DEDUCTION",
                     "appliedTdsAmount": 1000, "vendor": "Vendor One", "vendorId": "V1", "section": "194C"}],
    }, {"groupId": "CG-0002", "originalDocumentNumber": "X", "method": "DIFFERENCE_ONLY", "status": "draft",
        "entries": [{"correctionDocumentNumber": "CORR-X-01"}]}]

    assert import_legacy_groups(db, user, legacy) == {"imported": 1, "skipped": 1}
    assert import_legacy_groups(db, user, legacy) == {"imported": 0, "skipped": 2}
    group = db.query(CorrectionGroup).one()
    assert group.issue_key == "K1" and group.company_code == "1001"
    assert group_amounts(group)["unreconciledAmount"] == 0.0
    assert "Asha" in group.status_note


def test_allowed_actions_follow_maker_checker_rules(db):
    from services.correction_register import allowed_actions
    maker = _user(db, 1)
    admin = _user(db, 2, role="admin")
    other = _user(db, 3)
    group = create_group(db, maker, ISSUE, "DIFFERENCE_ONLY", None, [_row("5100000001", "ADDITIONAL_DEDUCTION", 1000)], None)
    assert allowed_actions(group, maker) == {"canUndo": True, "canReview": False}
    assert allowed_actions(group, admin) == {"canUndo": True, "canReview": True}
    assert allowed_actions(group, other) == {"canUndo": False, "canReview": False}
    review_group(db, admin, group, approve=True, note=None)
    assert allowed_actions(group, maker) == {"canUndo": False, "canReview": False}
    assert allowed_actions(group, admin) == {"canUndo": True, "canReview": False}
