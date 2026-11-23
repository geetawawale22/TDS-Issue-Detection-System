"""Rename issue "TDS Deducted as per LDC — Mismatch" to "TDS Not Deducted as per LDC"

One name for the LDC issue everywhere (filter, validation result, TDS note,
Open Issues tab). The category is part of the issue key
(services/issue_tracker.build_issue_key), so each saved issue's key is
rebuilt with the new name; the withholding type/code needed for that comes
from the issue's saved ledger line. An issue with no ledger line keeps its
key, and the next run that sends its line renames it as before
(issue_tracker._relabelled_issues). Saved validation rows (ledger_lines.event
and .report, stored as JSON with "—" escaped) get the new name too.

Revision ID: d4e9b1f7a3c2
Revises: c8f4a2d6e1b9
Create Date: 2026-11-23
"""
import hashlib
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d4e9b1f7a3c2"
down_revision: Union[str, Sequence[str], None] = "c8f4a2d6e1b9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

OLD = "TDS Deducted as per LDC — Mismatch"
NEW = "TDS Not Deducted as per LDC"


def _key(company: str, fiscal_year: str, doc_no: str, line_item: str, wtax_type: str, wtax_code: str, category: str) -> str:
    parts = [company, fiscal_year, doc_no, line_item, wtax_type, wtax_code, category]
    return hashlib.sha1("|".join(str(part or "").strip() for part in parts).encode("utf-8")).hexdigest()


def _json_text(value: str) -> str:
    """How json.dumps (ensure_ascii) writes the name inside the saved JSON."""
    return value.encode("ascii", "backslashreplace").decode("ascii")


def _rename(old: str, new: str) -> None:
    bind = op.get_bind()
    issues = bind.execute(
        sa.text(
            "SELECT id, issue_key, company_code, fiscal_year, doc_no, line_item "
            "FROM tracked_issues WHERE category = :old"
        ),
        {"old": old},
    ).fetchall()
    for issue in issues:
        lines = bind.execute(
            sa.text(
                "SELECT DISTINCT withholding_tax_type, withholding_tax_code FROM ledger_lines "
                "WHERE company_code = :c AND fiscal_year = :fy AND doc_no = :doc AND line_item = :line"
            ),
            {"c": issue.company_code, "fy": issue.fiscal_year, "doc": issue.doc_no, "line": issue.line_item},
        ).fetchall()
        identity = (issue.company_code, issue.fiscal_year, issue.doc_no, issue.line_item)
        new_key = next(
            (
                _key(*identity, line.withholding_tax_type, line.withholding_tax_code, new)
                for line in lines
                if _key(*identity, line.withholding_tax_type, line.withholding_tax_code, old) == issue.issue_key
            ),
            issue.issue_key,
        )
        taken = new_key != issue.issue_key and bind.execute(
            sa.text("SELECT 1 FROM tracked_issues WHERE issue_key = :k"), {"k": new_key},
        ).first()
        key = issue.issue_key if taken else new_key
        bind.execute(
            sa.text("UPDATE tracked_issues SET category = :new, issue_key = :k WHERE id = :id"),
            {"new": new, "k": key, "id": issue.id},
        )
        # Correction register entries point at the issue by its key.
        bind.execute(
            sa.text("UPDATE correction_groups SET issue_key = :k WHERE issue_key = :old_key"),
            {"k": key, "old_key": issue.issue_key},
        )
    bind.execute(sa.text("UPDATE correction_groups SET category = :new WHERE category = :old"), {"new": new, "old": old})

    for column in ("event", "report"):
        for text in {old, _json_text(old)}:
            replacement = new if text == old else _json_text(new)
            bind.execute(
                # "column <> replace(...)" picks the rows that contain the name; unlike
                # strpos (PostgreSQL only) or LIKE (backslash escapes) it works on
                # PostgreSQL and MySQL alike.
                sa.text(f"UPDATE ledger_lines SET {column} = replace({column}, :old, :new) WHERE {column} <> replace({column}, :old, :new)"),
                {"old": text, "new": replacement},
            )


def upgrade() -> None:
    _rename(OLD, NEW)


def downgrade() -> None:
    _rename(NEW, OLD)
