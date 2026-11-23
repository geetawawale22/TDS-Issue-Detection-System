"""SAP data API — fetch rows straight from Mahindra's SAP query service (admin only).

For checking what the API sends before its data replaces any Excel upload
(see services/sap_data_api.py).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from core.dependencies import require_admin
from db.models import User
from services import sap_data_api
from services.sap_data_api import MAX_PAGE_SIZE, SapDataApiError

router = APIRouter(prefix="/sap-data", tags=["SAP Data API"])


class QueryRequest(BaseModel):
    # SAP table / view names are letters, digits and underscores.
    table: str = Field(..., min_length=1, max_length=60, pattern=r"^[A-Za-z0-9_/]+$")
    page_no: int = Field(1, ge=1)
    page_size: int = Field(1000, ge=1, le=MAX_PAGE_SIZE)
    other_conditions: str = Field("", max_length=1000)


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
