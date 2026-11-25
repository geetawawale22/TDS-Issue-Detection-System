"""Fast bulk inserts for large analysis runs.

``Session.bulk_insert_mappings`` leaves out keys whose value is None, so the
column default applies, and batches only consecutive rows with the same keys.
Ledger lines and issues have a different mix of empty fields row by row, so a
75k-line run went out as thousands of tiny INSERTs. ``insert_rows`` fills in
those defaults itself and sends every row with the same keys, so the database
gets a few large batches; the saved values are the same.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session


def insert_rows(db: Session, model, rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    scalar_defaults: dict[str, Any] = {}
    server_defaults: set[str] = set()
    for column in model.__table__.columns:
        if column.default is not None and column.default.is_scalar:
            scalar_defaults[column.key] = column.default.arg
        elif column.server_default is not None:
            server_defaults.add(column.key)

    prepared = []
    for row in rows:
        row = dict(row)
        for key, default in scalar_defaults.items():
            if row.get(key) is None and key in row:
                row[key] = default
        for key in server_defaults:
            # An empty value here means "use the database default (e.g. now())".
            if key in row and row[key] is None:
                del row[key]
        prepared.append(row)
    db.bulk_insert_mappings(model, prepared, render_nulls=True)
