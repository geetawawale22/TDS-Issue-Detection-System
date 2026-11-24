"""SAP data API — read rows straight from Mahindra's SAP query service (admin only).

/query previews one page. /analyse runs the TDS analysis on every matching
vendor line item, exactly like an Excel upload (the run is saved, so every
page shows it), and /import-ldc saves exemption rows into LDC Master like the
certificate upload. See services/sap_data_api.py.
"""

from __future__ import annotations

from typing import Any

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from api.issues import analyse_frame
from api.ldc import _normalise_columns, import_certificate_frame
from core.dependencies import require_admin
from db.database import get_db
from db.models import User
from services import sap_data_api
from services.sap_data_api import MAX_PAGE_SIZE, SapDataApiError

router = APIRouter(prefix="/sap-data", tags=["SAP Data API"])


TABLE_PATTERN = r"^[A-Za-z0-9_/]+$"  # SAP table / view names
# Room for long pasted lists of document / vendor numbers (IN (...)).
CONDITIONS_MAX = 20000


class QueryRequest(BaseModel):
    table: str = Field(..., min_length=1, max_length=60, pattern=TABLE_PATTERN)
    page_no: int = Field(1, ge=1)
    page_size: int = Field(1000, ge=1, le=MAX_PAGE_SIZE)
    other_conditions: str = Field("", max_length=CONDITIONS_MAX)


class FetchAllRequest(BaseModel):
    table: str = Field(..., min_length=1, max_length=60, pattern=TABLE_PATTERN)
    other_conditions: str = Field("", max_length=CONDITIONS_MAX)
    # Company the filter is for ("" = all); stamped on rows without one.
    company_code: str = Field("", max_length=20)
    include_informational: bool = True


def _fetch_frame(request: FetchAllRequest) -> pd.DataFrame:
    try:
        rows = sap_data_api.fetch_all(request.table.strip(), request.other_conditions.strip())
    except SapDataApiError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=exc.message) from exc
    if not rows:
        raise HTTPException(status_code=422, detail="No rows match these filters, so there is nothing to process.")
    frame = pd.DataFrame(rows)
    frame.columns = [str(column).strip() for column in frame.columns]
    # Blank strings from the API count as empty, like empty Excel cells.
    return frame.replace(r"^\s*$", None, regex=True)


@router.get("/config")
def get_config(_: User = Depends(require_admin)) -> dict[str, Any]:
    return sap_data_api.config()


@router.post("/query")
def run_query(request: QueryRequest, _: User = Depends(require_admin)) -> dict[str, Any]:
    try:
        page = sap_data_api.query(request.table.strip(), request.page_no, request.page_size, request.other_conditions.strip())
    except SapDataApiError as exc:
        # 502: the upstream API failed, not this request.
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=exc.message) from exc
    return {
        "table": request.table.strip(),
        "pageNo": request.page_no,
        "pageSize": request.page_size,
        "rowCount": len(page.rows),
        "rows": page.rows,
        "meta": page.meta,
        "elapsedMs": page.elapsed_ms,
    }


@router.post("/analyse")
def analyse(request: FetchAllRequest, current_user: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Run the TDS analysis on every vendor line item matching the filters (like an Excel upload)."""
    frame = _fetch_frame(request)
    label = f"SAP API · {request.table.strip()}"
    return analyse_frame(
        frame,
        filename=label,
        filenames=[label],
        company_code=request.company_code,
        include_informational=request.include_informational,
        current_user=current_user,
        db=db,
        source="sap_api",
    )


@router.post("/import-ldc")
def import_ldc(request: FetchAllRequest, _: User = Depends(require_admin), db: Session = Depends(get_db)) -> dict[str, Any]:
    """Save every exemption row matching the filters into LDC Master (like the certificate upload)."""
    return import_certificate_frame(_normalise_columns(_fetch_frame(request)), db)
