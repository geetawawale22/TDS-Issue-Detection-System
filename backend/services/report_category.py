"""Business report category for every transaction (Reports → TDS Category Report).

Mahindra's scenario workbook ("TDS Devlopement IT") sorts transactions into
eight sheets: TDS Properly Deducted, TDS not Applicable, Short TDS Deducted,
Excess TDS Deducted, TDS Deducted as per LDC, TDS Not Deducted, 100% TDS on
Advance and Partial TDS on Advance. ``report_fields`` puts each validation row
in exactly one of them, or in "other" when the rules could not decide (missing
data, section missing). It also adds the columns that workbook shows: the TDS
that was applicable next to the TDS that was deducted, and a remark.

The rule engine stays the source of truth: categories are read from the rule
results already produced for the row, never re-derived here.
"""
from __future__ import annotations

from typing import Any

from rules.tds_rule_engine import (
    TDSIssue,
    _is_advance_clearing_adjustment,
    ldc_decides_transaction,
    link_advances_to_invoices,
    rent_nature,
)

PROPERLY_DEDUCTED = "properly_deducted"
NOT_APPLICABLE = "not_applicable"
SHORT = "short"
EXCESS = "excess"
LDC = "ldc"
NOT_DEDUCTED = "not_deducted"
ADVANCE_FULL = "advance_full"
ADVANCE_PARTIAL = "advance_partial"
OTHER = "other"
# Not a business sheet: rows whose issue a correction, reversal or manual
# review resolved. Kept apart so the issue sheets hold open issues only and
# their count matches Open Issues.
RESOLVED = "resolved"

# Under ₹1 either way is rounding, not a short/excess deduction.
_AMOUNT_TOLERANCE = 1.0

# Note api/issues.py _build_tds_notes gives a payment that carries no TDS duty.
_PAYMENT_AGAINST_INVOICE_NOTE = "Payment against invoice"


def _amount(value: Any) -> float:
    try:
        return abs(float(value or 0.0))
    except (TypeError, ValueError):
        return 0.0


def _doc(value: Any) -> str:
    return str(value or "").strip()


def build_advance_roles(transactions) -> dict[int, tuple[str, str]]:
    """id(txn) -> (category, linked document numbers) for advance chains.

    Only chains where TDS was taken on the advance count as "TDS on advance":
    the invoice carrying no TDS of its own is the 100% case, the invoice
    deducting the rest is the partial case. A chain with no TDS on the advance
    is left to the normal checks (TDS Not Deducted — Advance Payment). Chains
    an LDC certificate covers are reported under LDC instead.
    """
    roles: dict[int, tuple[str, str]] = {}
    for invoice, advances in link_advances_to_invoices(transactions):
        if ldc_decides_transaction(invoice):
            continue
        advance_tds = sum(_amount(advance.tds_deducted_amount) for advance in advances)
        if advance_tds <= 0:
            continue
        category = ADVANCE_PARTIAL if _amount(invoice.tds_deducted_amount) > 0 else ADVANCE_FULL
        advance_docs = ", ".join(sorted({_doc(advance.doc_number) for advance in advances if _doc(advance.doc_number)}))
        roles[id(invoice)] = (category, advance_docs)
        for advance in advances:
            roles.setdefault(id(advance), (category, _doc(invoice.doc_number)))
    return roles


def _category_for_issue(category: str, applicable_amount: float | None, deducted: float) -> str:
    text = category.lower()
    if "ldc" in text:
        return LDC
    if text.startswith("tds not applicable"):
        return NOT_APPLICABLE
    if text == "tds section missing":
        return OTHER
    # Advance issues sit with the advances (TDS on Advance), even when no TDS
    # was taken on the advance, so there is no advance chain: TDS missed on the
    # advance itself was due in full at payment; a short/excess on an invoice
    # adjusted against an advance is TDS split across the two.
    if "advance payment" in text:
        return ADVANCE_FULL
    if "advance adjusted" in text:
        return ADVANCE_PARTIAL
    # Nothing deducted where TDS was due is "not deducted", whatever the
    # rule's own wording (e.g. a 0% "Wrong TDS Rate" or an amount check).
    if deducted <= 0 and (applicable_amount is None or applicable_amount > 0):
        return NOT_DEDUCTED
    if "not deducted" in text or "possible missed" in text:
        return NOT_DEDUCTED
    if "short tds" in text or "short deducted" in text or text.startswith("short "):
        return SHORT
    if text.startswith("excess"):
        return EXCESS
    # Short/Excess TDS Deducted, Wrong TDS Rate, Wrong Section Applied,
    # correction mismatches: the direction comes from the amounts.
    if applicable_amount is None:
        return OTHER
    if deducted <= 0 < applicable_amount:
        return NOT_DEDUCTED
    if applicable_amount > deducted + _AMOUNT_TOLERANCE:
        return SHORT
    if deducted > applicable_amount + _AMOUNT_TOLERANCE:
        return EXCESS
    return OTHER


def issue_report_category(issue: dict[str, Any], txn, advance_role: tuple[str, str] | None) -> str:
    """Business sheet for one reported issue (as report_fields files a row by its first issue)."""
    category = _category_for_issue(
        issue["category"],
        _applicable_amount(issue.get("baseAmount"), issue.get("expectedRate")),
        _amount(txn.tds_deducted_amount),
    )
    if advance_role and "advance" in issue["category"].lower():
        category = advance_role[0]
    return category


def saved_issue_report_category(category: str, base: Any, expected_rate: Any, tds: Any) -> str:
    """Same, for an issue saved before the category was stored (no advance-chain context)."""
    return _category_for_issue(category or "", _applicable_amount(base, expected_rate), _amount(tds))


def _needs_review(info_issue: TDSIssue | None, tds_note: str) -> bool:
    if info_issue and "possible missed" in info_issue.category.lower():
        return True
    note = tds_note.lower()
    return note.startswith("cannot verify") or "please review" in note or "check the advance" in note


def _applicable_amount(base: Any, rate: Any) -> float | None:
    if base is None or rate is None:
        return None
    try:
        return round(abs(float(base)) * float(rate) / 100, 2)
    except (TypeError, ValueError):
        return None


def report_fields(
    txn,
    row: dict[str, Any],
    issue: dict[str, Any] | None,
    info_issue: TDSIssue | None,
    advance_role: tuple[str, str] | None,
    in_ldc_chain: bool = False,
) -> dict[str, Any]:
    """Report category plus the workbook's extra columns for one validation row.

    ``issue`` is the row's first reported issue (as sent to the UI), and
    ``info_issue`` its first informational rule result ("TDS Deducted as per
    LDC", "TDS Not Applicable", ...), which is not reported as an issue.
    """
    status = row.get("status")
    deducted = _amount(txn.tds_deducted_amount)
    base = row.get("baseAmount")
    tds_note = row.get("tdsNote") or ""

    # An informational result reported as an issue (include_informational)
    # describes a correct row, so it is read as one.
    if issue is not None and issue.get("severity") == "low":
        info_issue = info_issue or TDSIssue(category=issue["category"], message=issue.get("description") or "", severity="low")
        issue = None

    applicable_section = row.get("section")
    applicable_rate = row.get("expectedRate")
    if issue is not None:
        applicable_section = issue.get("ruleSection") or applicable_section
        if issue.get("expectedRate") is not None:
            applicable_rate = issue["expectedRate"]
    applicable_amount = _applicable_amount(base, applicable_rate)

    linked_doc = advance_role[1] if advance_role else ""
    if issue is not None:
        category = _category_for_issue(issue["category"], applicable_amount, deducted)
        # Issues on an advance chain stay with the chain, so the advance and
        # invoice are seen together.
        if advance_role and "advance" in issue["category"].lower():
            category = advance_role[0]
        remark = issue.get("description") or issue["category"]
    elif advance_role:
        category = advance_role[0]
        remark = (
            f"TDS deducted on advance; invoice {linked_doc} carries no further TDS."
            if category == ADVANCE_FULL and txn.is_advance_payment
            else f"TDS was already deducted on advance {linked_doc}, so none is due on this invoice."
            if category == ADVANCE_FULL
            else f"Part of the TDS deducted on advance; the rest on invoice {linked_doc}."
            if txn.is_advance_payment
            else f"Part of the TDS was deducted on advance {linked_doc}; the rest on this invoice."
        )
    elif in_ldc_chain or ldc_decides_transaction(txn) or (info_issue and "ldc" in info_issue.category.lower()):
        category = LDC
        remark = (info_issue.message if info_issue else "") or tds_note or row.get("reason") or ""
    elif deducted <= 0 and tds_note.startswith(_PAYMENT_AGAINST_INVOICE_NOTE):
        # A plain payment against an invoice: TDS belongs to the invoice, so
        # none is due here, even when SAP gives the payment no section.
        category = NOT_APPLICABLE
        remark = tds_note
    elif status == "insufficient":
        category = OTHER
        remark = row.get("reason") or tds_note
    elif info_issue and info_issue.category.lower().startswith("tds not applicable"):
        category = NOT_APPLICABLE
        remark = info_issue.message
    elif _is_advance_clearing_adjustment(txn) and tds_note.startswith("Advance adjustment — TDS of"):
        category = ADVANCE_FULL
        linked_doc = _doc(txn.invoice_reference_document)
        remark = tds_note
    elif deducted > 0 and status != "skipped":
        category = PROPERLY_DEDUCTED
        if applicable_rate is None:
            # The rules passed the row but have no single statutory rate for
            # its section (e.g. 195, DTAA-based), so the rate was not checked.
            applied = row.get("appliedRate")
            applied_text = f" at {float(applied):g}%" if applied is not None else ""
            remark = (
                f"Rate not verified — no single statutory rate is configured for section "
                f"{applicable_section or '—'}; TDS deducted{applied_text}."
            )
        elif applicable_section == "194I" and rent_nature(txn) is None:
            remark = (
                f"Rent TDS at {float(applicable_rate):g}% accepted — SAP does not say whether plant/machinery "
                f"(2%) or land/building/furniture (10%) was rented."
            )
        else:
            remark = (info_issue.message if info_issue else "") or tds_note or "TDS deducted at the expected rate."
    elif status != "skipped" and _needs_review(info_issue, tds_note):
        # No TDS, and the rules could neither confirm it is fine nor call it
        # an issue (a low-confidence "possible missed" flag, or SAP values
        # missing). Not an issue on the Issues page, but not "not applicable".
        category = OTHER
        remark = (info_issue.message if info_issue else "") or tds_note
    else:
        # Passed with no TDS (below threshold, payment against an invoice,
        # clearing or transfer entry) or a skipped document: not validated as
        # a TDS event (e.g. a credit note correcting an invoice), so no TDS
        # is due on it here.
        category = NOT_APPLICABLE
        remark = (row.get("reason") if status == "skipped" else None) or tds_note or row.get("reason") or "No TDS required on this document."

    if category == NOT_APPLICABLE and deducted <= 0:
        applicable_section = applicable_rate = applicable_amount = None

    return {
        "reportCategory": category,
        "applicableSection": applicable_section if applicable_section not in ("", "—") else None,
        "applicableRate": applicable_rate,
        "applicableAmount": applicable_amount,
        "deductedSection": (txn.tds_deducted_section or txn.tds_legacy_section or txn.tds_new_section) if deducted > 0 else None,
        # Rate as keyed in SAP; appliedRate is amount ÷ base (2.0001%).
        "deductedRate": txn.tds_deducted_rate if deducted > 0 else None,
        "remark": remark,
        "linkedDoc": linked_doc or None,
        "person": txn.person,
        "billNo": txn.bill_no,
        "txnDescription": txn.description,
        "glAccount": txn.gl_account or None,
        "glDescription": txn.gl_description,
        "issueCategory": issue["category"] if issue is not None else (info_issue.category if info_issue else None),
    }


def _money(value: Any) -> float:
    try:
        return float(value or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _format_inr(value: float) -> str:
    return f"₹{value:,.2f}"


def _apply_resolution(row: dict[str, Any]) -> None:
    """File one 'corrected' row under Resolved Issues.

    ``resolvedFrom`` keeps the sheet the row would be on by its original
    issue (e.g. Short TDS Deducted). The amounts show where it stands now:
      * correction posted -> "TDS Deducted" is the posted TDS plus the top-up;
      * document reversed -> nothing applicable any more;
      * resolved by hand  -> amounts as posted, the remark says it was resolved.
    """
    resolution = row.get("resolutionType")
    docs = [doc for doc in row.get("correctionDocs") or [] if isinstance(doc, dict) and doc.get("docNo")]
    doc_list = ", ".join(str(doc["docNo"]) for doc in docs)
    was = row.get("issueCategory") or row.get("originalReason") or "Issue"
    row["resolvedFrom"] = row.get("reportCategory")
    row["reportCategory"] = RESOLVED
    if doc_list:
        row["linkedDoc"] = doc_list

    if resolution == "CORRECTION_POSTED":
        posted = abs(_money(row.get("tdsAmount")))
        top_up = sum(_money(doc.get("tdsEffect", doc.get("tdsAmount"))) for doc in docs)
        corrected = round(posted + top_up, 2)
        dates = sorted({str(doc["postingDate"])[:10] for doc in docs if doc.get("postingDate")})
        on_dates = f" on {', '.join(dates)}" if dates else ""
        row.update({
            "reportTdsAmount": corrected,
            "deductedSection": row.get("applicableSection") or row.get("deductedSection"),
            "deductedRate": row.get("applicableRate") if row.get("applicableRate") is not None else row.get("deductedRate"),
            "remark": (
                f"{was} when posted ({_format_inr(posted)} deducted); corrected by {doc_list or 'a later entry'}"
                f"{on_dates} ({'+' if top_up >= 0 else '−'}{_format_inr(abs(top_up))}). "
                f"TDS now {_format_inr(corrected)}, matching the expected amount."
            ),
        })
    elif resolution == "REVERSED":
        row.update({
            "applicableSection": None,
            "applicableRate": None,
            "applicableAmount": None,
            "remark": f"Document cancelled by {doc_list or 'a reversal'}; no TDS is due on it now (was: {was}).",
        })
    else:
        note = row.get("reason") or "Resolved in the issue history."
        row["remark"] = f"{row.get('remark') or was} — Resolved: {note}"


def apply_resolutions(rows: list[dict[str, Any]]) -> None:
    """Move rows whose issue was resolved to Resolved Issues (see _apply_resolution).

    A correction line in the same upload whose original was resolved goes
    there too, marked ``reportCountedOn``: its TDS is already in the
    original's deducted amount, so report totals count it once.
    """
    resolved: set[tuple[str, str]] = set()
    for row in rows:
        if row.get("status") == "corrected":
            _apply_resolution(row)
            resolved.add((str(row.get("companyCode") or ""), _doc(row.get("docNo"))))

    for row in rows:
        if row.get("rowKind") != "correction":
            continue
        original = _doc(row.get("correctionOf"))
        if (str(row.get("companyCode") or ""), original) not in resolved:
            continue
        row.update({
            "resolvedFrom": row.get("reportCategory"),
            "reportCategory": RESOLVED,
            "reportCountedOn": original,
            "linkedDoc": original,
            "remark": (
                f"Correction entry for document {original}; its TDS is included in that document's "
                f"TDS deducted, so it is not counted again in the totals."
            ),
        })
