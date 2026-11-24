"""Read-only check of a SAP data API run: what the API sends and what got saved.

Changes nothing. Run on the machine that can reach the SAP API (VPN), after
"Run TDS analysis" from Settings → SAP Data API, and share the output.

    python diag_sap_api.py
    python diag_sap_api.py --date 2027-01-07      # sample API rows for one posting date
    python diag_sap_api.py --no-api               # database part only
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from sqlalchemy import text  # noqa: E402

from db.database import engine  # noqa: E402

VENDOR_ITEMS = "ZAPI_TDS_VENDOR_ITEMS"
# Columns the analysis and the page filters depend on.
KEY_COLUMNS = [
    "Company_Code", "Fiscal_Year", "Posting_Date", "Document_Date", "Document_No", "Document_Number",
    "Line_Item", "Document_Type", "Vendor_Code", "PAN", "TDS_Section", "TDS_Rate", "Basic_Amount",
    "Bill_Amount", "TDS_Amount", "Withholding_Tax_Type", "Withholding_Tax_Code", "Clearing_Document",
]


def arg(name):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv and sys.argv.index(name) + 1 < len(sys.argv) else None


def section(title):
    print(f"\n===== {title} =====")


def database_part():
    with engine.connect() as conn:
        section("Last 5 runs")
        runs = conn.execute(text(
            "SELECT id, source, file_name, company_codes, period_from, period_to, transactions, issues_found, created_at "
            "FROM rule_runs ORDER BY id DESC LIMIT 5"
        )).mappings().all()
        for run in runs:
            print(dict(run))
        if not runs:
            print("No runs saved.")
            return
        run_id = runs[0]["id"]

        section(f"Tracked issues of run {run_id} by company / fiscal year / status")
        for row in conn.execute(text(
            "SELECT company_code, fiscal_year, status, COUNT(*) AS n FROM tracked_issues "
            "WHERE last_seen_run_id = :r GROUP BY company_code, fiscal_year, status"
        ), {"r": run_id}).all():
            print(tuple(row))

        section(f"Tracked issues of run {run_id} by category / report category")
        for row in conn.execute(text(
            "SELECT category, report_category, COUNT(*) AS n FROM tracked_issues "
            "WHERE last_seen_run_id = :r GROUP BY category, report_category ORDER BY n DESC"
        ), {"r": run_id}).all():
            print(tuple(row))

        section(f"3 sample tracked issues of run {run_id}")
        for row in conn.execute(text(
            "SELECT company_code, fiscal_year, doc_no, line_item, doc_type, posting_date, vendor_code, section, "
            "base_amount, tds_amount, category, report_category, status FROM tracked_issues "
            "WHERE last_seen_run_id = :r ORDER BY id LIMIT 3"
        ), {"r": run_id}).mappings().all():
            print(dict(row))

        section(f"Ledger lines of run {run_id} by company / fiscal year")
        for row in conn.execute(text(
            "SELECT company_code, fiscal_year, COUNT(*) AS n FROM ledger_lines "
            "WHERE last_run_id = :r GROUP BY company_code, fiscal_year"
        ), {"r": run_id}).all():
            print(tuple(row))

        section(f"3 sample ledger lines of run {run_id}")
        for row in conn.execute(text(
            "SELECT company_code, fiscal_year, doc_no, line_item, doc_type, event_type, posting_date, group_key, "
            "clearing_document, gl_account, section, base_amount, tds_amount, report_category FROM ledger_lines "
            "WHERE last_run_id = :r ORDER BY id LIMIT 3"
        ), {"r": run_id}).mappings().all():
            print(dict(row))

        section("Ledger groups (total)")
        print(conn.execute(text("SELECT COUNT(*) FROM ledger_groups")).scalar())


def api_part():
    from services import sap_data_api

    date = arg("--date")
    conditions = f"Posting_Date = '{date}'" if date else ""
    section(f"API sample: {VENDOR_ITEMS} {conditions or '(no filter)'}")
    try:
        page = sap_data_api.query(VENDOR_ITEMS, 1, 3, conditions)
    except sap_data_api.SapDataApiError as exc:
        print(f"API call failed: {exc.message}")
        return
    print(f"meta: {page.meta}")
    if not page.rows:
        print("No rows returned.")
        return
    columns = list(page.rows[0].keys())
    print(f"{len(columns)} columns: {columns}")
    print("\nKey columns (Python type and value, per sample row):")
    for name in KEY_COLUMNS:
        if name in page.rows[0]:
            values = [f"{type(row.get(name)).__name__}:{row.get(name)!r}" for row in page.rows]
            print(f"  {name}: {values}")
        else:
            print(f"  {name}: -- not in API data --")


if __name__ == "__main__":
    database_part()
    if "--no-api" not in sys.argv:
        api_part()
