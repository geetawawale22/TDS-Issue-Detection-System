"""LDC master upload and validation endpoints."""

from __future__ import annotations

from datetime import date
from io import BytesIO
from pathlib import Path
from typing import Any

import pandas as pd
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from core.dependencies import get_current_user
from db.database import get_db
from db.models import LDCCertificateMaster, User, VendorMaster


router = APIRouter(prefix="/ldc", tags=["LDC Compliance"])

MAX_UPLOAD_BYTES = 25 * 1024 * 1024
SUPPORTED_EXTENSIONS = {".csv", ".xlsx", ".xlsm"}

REQUIRED_CERTIFICATE_COLUMNS = {
    "PAN",
    "Company_Code",
    "Exemption_Number",
    "Exemption_Percentage",
    "Exemption_From",
    "Exemption_To",
}

REQUIRED_VENDOR_COLUMNS = {"PAN", "VendorName", "VendorCode"}


def _is_blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip()) or pd.isna(value)


def _clean(value: Any) -> str:
    if _is_blank(value):
        return ""
    return str(value).strip()


def _clean_upper(value: Any) -> str:
    return _clean(value).upper()


def _get(row: dict[str, Any], *names: str) -> Any:
    for name in names:
        value = row.get(name)
        if not _is_blank(value):
            return value
    return ""


def _extract_pan(value: Any) -> str:
    text = _clean_upper(value)
    if len(text) == 15:
        candidate = text[2:12]
        if len(candidate) == 10:
            return candidate
    return text


def _ldc_section_key(row: dict[str, Any]) -> str:
    explicit_section = _clean_upper(_get(row, "TDS_Section", "Applicable_TDS_Section"))
    if explicit_section:
        return explicit_section

    wtax_type = _clean_upper(_get(row, "WTax_Type"))
    wtx = _clean_upper(_get(row, "WTx"))
    if wtax_type and wtx:
        return f"{wtax_type}/{wtx}"
    return wtx or wtax_type


def _to_bool(value: Any, default: bool = False) -> bool:
    if _is_blank(value):
        return default
    return _clean(value).lower() in {"true", "yes", "y", "1", "verified", "x", "active"}


def _to_date(value: Any) -> date | None:
    if _is_blank(value):
        return None
    if isinstance(value, pd.Timestamp):
        return value.date()
    if isinstance(value, date):
        return value
    text = _clean(value)
    if text.isdigit() and len(text) == 8:
        parsed = pd.to_datetime(text, format="%Y%m%d", errors="coerce")
    else:
        parsed = pd.to_datetime(value, errors="coerce", dayfirst=False)
    if pd.isna(parsed):
        return None
    return parsed.date()


def _to_float(value: Any) -> float | None:
    if _is_blank(value):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _normalise_columns(frame: pd.DataFrame) -> pd.DataFrame:
    frame = frame.copy()
    frame.columns = [str(column).strip().replace(" ", "_") for column in frame.columns]
    return frame


def _read_upload(filename: str, content: bytes) -> pd.DataFrame:
    suffix = Path(filename).suffix.lower()
    if suffix not in SUPPORTED_EXTENSIONS:
        raise HTTPException(status_code=415, detail="Upload a CSV, XLSX, or XLSM file.")

    if suffix == ".csv":
        try:
            return pd.read_csv(BytesIO(content))
        except UnicodeDecodeError:
            return pd.read_csv(BytesIO(content), encoding="latin-1")

    try:
        return pd.read_excel(BytesIO(content), engine="openpyxl")
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Could not read the spreadsheet. Ensure the first worksheet has a header row and is not password protected.",
        ) from exc


async def _read_frame(file: UploadFile) -> pd.DataFrame:
    filename = file.filename or "upload"
    content = await file.read()
    if not content:
        raise HTTPException(status_code=422, detail="The uploaded file is empty.")
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="The uploaded file exceeds the 25 MB limit.")

    frame = _normalise_columns(_read_upload(filename, content))
    if frame.empty:
        raise HTTPException(status_code=422, detail="The uploaded file has no rows.")
    return frame


def _validate_certificate(row: dict[str, Any], vendor_pans: set[str]) -> list[str]:
    issues: list[str] = []
    cert_type = _clean_upper(_get(row, "Certificate_Type")) or "LOWER"
    pan = _extract_pan(_get(row, "PAN", "Tax_Number_3", "Tax_Number_1"))
    rate = _to_float(_get(row, "Approved_TDS_Rate", "Exemption_Percentage"))
    valid_from = _to_date(_get(row, "Valid_From", "Exemption_From"))
    valid_to = _to_date(_get(row, "Valid_To", "Exemption_To"))
    status_value = _clean_upper(_get(row, "Status")) or "ACTIVE"

    if not _clean(_get(row, "Certificate_Number", "Exemption_Number")):
        issues.append("Certificate number missing")
    if cert_type not in {"LOWER", "NIL"}:
        issues.append("Certificate type must be LOWER or NIL")
    if not pan:
        issues.append("PAN missing")
    if not _clean(_get(row, "Vendor_Name", "Supplier_Name", "Supplier")):
        issues.append("Vendor name missing")
    if not _clean(_get(row, "Company_Code")):
        issues.append("Company code missing")
    if not _ldc_section_key(row):
        issues.append("TDS section missing")
    if rate is None:
        issues.append("Approved TDS rate missing/invalid")
    elif rate < 0:
        issues.append("Approved TDS rate cannot be negative")
    if cert_type == "NIL" and rate != 0:
        issues.append("NIL certificate must have 0% approved rate")
    if valid_from is None:
        issues.append("Valid From date missing/invalid")
    if valid_to is None:
        issues.append("Valid To date missing/invalid")
    if valid_from and valid_to and valid_from > valid_to:
        issues.append("Valid From is after Valid To")
    if status_value != "ACTIVE":
        issues.append("Certificate status is not ACTIVE")
    if not _to_bool(_get(row, "Is_Verified", "W_Tax"), default=True):
        issues.append("Certificate not verified")
    if _to_bool(row.get("Is_Child_Certificate")) and not _clean(row.get("Parent_Certificate_Number")):
        issues.append("Child certificate missing parent certificate")

    return issues


@router.post("/upload-vendors")
async def upload_vendor_master(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Upsert vendor master rows from a temporary CSV/XLSX file."""
    del current_user
    frame = await _read_frame(file)
    missing = sorted(REQUIRED_VENDOR_COLUMNS.difference(frame.columns))
    if missing:
        raise HTTPException(status_code=422, detail=f"Missing columns: {', '.join(missing)}")

    inserted = 0
    updated = 0
    issues = []

    for index, row in frame.iterrows():
        vendor_code = _clean(row.get("VendorCode"))
        vendor_name = _clean(row.get("VendorName"))
        pan = _clean_upper(row.get("PAN"))

        row_issues = []
        if not vendor_code:
            row_issues.append("Vendor code missing")
        if not vendor_name:
            row_issues.append("Vendor name missing")
        if not pan:
            row_issues.append("PAN missing")
        if row_issues:
            issues.append({"rowNumber": int(index) + 2, "vendorCode": vendor_code, "issues": row_issues})
            continue

        existing = db.query(VendorMaster).filter(VendorMaster.vendor_code == vendor_code).first()
        if existing:
            existing.vendor_name = vendor_name
            existing.vendor_pan = pan
            existing.is_active = True
            updated += 1
        else:
            db.add(VendorMaster(vendor_code=vendor_code, vendor_name=vendor_name, vendor_pan=pan, is_active=True))
            inserted += 1

    db.commit()
    return {"inserted": inserted, "updated": updated, "issueRows": len(issues), "issues": issues}


@router.get("/certificates")
def list_ldc_certificates(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Return saved LDC certificates so the frontend survives refresh."""
    del current_user
    rows = db.query(LDCCertificateMaster).order_by(
        LDCCertificateMaster.vendor_pan,
        LDCCertificateMaster.certificate_number,
    ).all()
    return {
        "certificates": [
            {
                "rowNumber": index + 1,
                "certificateNumber": row.certificate_number,
                "certificateType": row.certificate_type,
                "pan": row.vendor_pan,
                "vendorCode": row.vendor_code,
                "vendorName": row.vendor_name,
                "companyCode": row.company_code,
                "deductorTan": row.deductor_tan,
                "section": row.applicable_tds_section,
                "approvedRate": float(row.approved_tds_rate),
                "validFrom": row.valid_from.isoformat() if row.valid_from else None,
                "validTo": row.valid_to.isoformat() if row.valid_to else None,
                "taxYear": row.tax_year,
                "approvedLimit": float(row.approved_amount_limit) if row.approved_amount_limit is not None else None,
                "status": row.status,
                "isVerified": row.is_verified,
                "lastVerifiedDate": row.last_verified_date.isoformat() if row.last_verified_date else None,
                "parentCertificateNumber": row.parent_certificate_number,
                "isChildCertificate": row.is_child_certificate,
                "remarks": row.remarks,
                "issues": [],
            }
            for index, row in enumerate(rows)
        ],
    }


@router.post("/upload-certificates")
async def upload_ldc_certificates(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Validate and upsert LDC certificate master rows."""
    del current_user
    frame = await _read_frame(file)
    missing = sorted(REQUIRED_CERTIFICATE_COLUMNS.difference(frame.columns))
    if missing:
        raise HTTPException(status_code=422, detail=f"Missing columns: {', '.join(missing)}")

    vendor_pans = {row.vendor_pan for row in db.query(VendorMaster.vendor_pan).filter(VendorMaster.is_active == True).all()}
    inserted = 0
    updated = 0
    issue_rows = []
    certificate_rows = []
    staged_vendor_codes: set[str] = set()

    for index, row in frame.iterrows():
        row_dict = row.to_dict()
        row_number = int(index) + 2
        issues = _validate_certificate(row_dict, vendor_pans)

        cert_number = _clean(_get(row_dict, "Certificate_Number", "Exemption_Number"))
        pan = _extract_pan(_get(row_dict, "PAN", "Tax_Number_3", "Tax_Number_1"))
        vendor_code = _clean(_get(row_dict, "Vendor_Code", "Supplier"))
        vendor_name = _clean(_get(row_dict, "Vendor_Name", "Supplier_Name", "Supplier"))
        company_code = _clean(_get(row_dict, "Company_Code")) or None
        deductor_tan = _clean_upper(_get(row_dict, "Deductor_TAN")) or None
        section = _ldc_section_key(row_dict)
        certificate_type = _clean_upper(_get(row_dict, "Certificate_Type")) or "LOWER"
        status_value = _clean_upper(_get(row_dict, "Status")) or "ACTIVE"
        approved_rate = _to_float(_get(row_dict, "Approved_TDS_Rate", "Exemption_Percentage"))

        certificate_rows.append({
            "rowNumber": row_number,
            "certificateNumber": cert_number,
            "pan": pan,
            "vendorName": vendor_name,
            "companyCode": company_code,
            "deductorTan": deductor_tan,
            "section": section,
            "approvedRate": approved_rate,
            "status": status_value,
            "isVerified": _to_bool(_get(row_dict, "Is_Verified", "W_Tax"), default=True),
            "issues": issues,
        })

        persist_blockers = []
        if not cert_number:
            persist_blockers.append("Certificate number missing")
        if not pan:
            persist_blockers.append("PAN missing")
        if not section:
            persist_blockers.append("TDS section missing")
        if approved_rate is None:
            persist_blockers.append("Approved TDS rate missing/invalid")
        if _to_date(_get(row_dict, "Valid_From", "Exemption_From")) is None:
            persist_blockers.append("Valid From date missing/invalid")
        if _to_date(_get(row_dict, "Valid_To", "Exemption_To")) is None:
            persist_blockers.append("Valid To date missing/invalid")

        if persist_blockers:
            certificate_rows[-1]["issues"] = sorted(set(issues + persist_blockers))
            issue_rows.append(certificate_rows[-1])
            continue

        if issues:
            issue_rows.append(certificate_rows[-1])

        if vendor_code and pan and vendor_name and vendor_code not in staged_vendor_codes:
            existing_vendor = db.query(VendorMaster).filter(VendorMaster.vendor_code == vendor_code).first()
            if existing_vendor:
                existing_vendor.vendor_name = vendor_name
                existing_vendor.vendor_pan = pan
                existing_vendor.is_active = True
            else:
                db.add(VendorMaster(
                    vendor_code=vendor_code,
                    vendor_name=vendor_name,
                    vendor_pan=pan,
                    is_active=True,
                ))
            staged_vendor_codes.add(vendor_code)

        existing = db.query(LDCCertificateMaster).filter(
            LDCCertificateMaster.certificate_number == cert_number,
            LDCCertificateMaster.vendor_pan == pan,
            LDCCertificateMaster.deductor_tan == deductor_tan,
            LDCCertificateMaster.applicable_tds_section == section,
        ).first()

        values = {
            "certificate_type": certificate_type,
            "vendor_code": vendor_code or None,
            "vendor_name": vendor_name,
            "company_code": company_code,
            "approved_tds_rate": approved_rate,
            "valid_from": _to_date(_get(row_dict, "Valid_From", "Exemption_From")),
            "valid_to": _to_date(_get(row_dict, "Valid_To", "Exemption_To")),
            "tax_year": _clean(_get(row_dict, "Tax_Year")) or None,
            "approved_amount_limit": _to_float(_get(row_dict, "Approved_Amount_Limit")),
            "status": status_value,
            "is_verified": _to_bool(_get(row_dict, "Is_Verified", "W_Tax"), default=True),
            "last_verified_date": _to_date(_get(row_dict, "Last_Verified_Date")),
            "parent_certificate_number": _clean(_get(row_dict, "Parent_Certificate_Number")) or None,
            "is_child_certificate": _to_bool(_get(row_dict, "Is_Child_Certificate")),
            "remarks": _clean(_get(row_dict, "Remarks", "Exemption_Reason")) or None,
        }

        if existing:
            for key, value in values.items():
                setattr(existing, key, value)
            updated += 1
        else:
            db.add(LDCCertificateMaster(
                certificate_number=cert_number,
                vendor_pan=pan,
                deductor_tan=deductor_tan,
                applicable_tds_section=section,
                amount_utilized=0,
                **values,
            ))
            inserted += 1

    db.commit()
    return {
        "totalRows": len(certificate_rows),
        "inserted": inserted,
        "updated": updated,
        "validRows": inserted + updated,
        "issueRows": len(issue_rows),
        "issues": issue_rows,
        "certificates": certificate_rows,
    }
