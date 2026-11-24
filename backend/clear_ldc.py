"""Clear LDC Master so it can be refilled (e.g. from Settings → SAP Data API).

Deletes every row from the LDC certificate master and the LDC upload issue
rows, after showing the counts and asking for YES. Uses DATABASE_URL from
backend/.env, so it works on PostgreSQL and MySQL alike.

    python clear_ldc.py                  # LDC certificates + upload issue rows
    python clear_ldc.py --with-vendors   # also vendor_master (vendor code / name / PAN)
"""
import sys
from pathlib import Path

# Run from any folder: make the backend packages importable.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from sqlalchemy import text  # noqa: E402

from db.database import engine  # noqa: E402

TABLES = ["ldc_certificate_master", "ldc_upload_issue_rows"]
if "--with-vendors" in sys.argv:
    TABLES.append("vendor_master")


def print_counts(conn):
    for table in TABLES:
        count = conn.execute(text(f"SELECT COUNT(*) FROM {table}")).scalar()
        print(f"  {table}: {count}")


def main():
    with engine.begin() as conn:
        print(f"Database: {engine.url.render_as_string(hide_password=True)}")
        print("Before:")
        print_counts(conn)
        answer = input("Delete all rows from these tables? Type YES to continue: ")
        if answer.strip() != "YES":
            print("Cancelled, nothing deleted.")
            return
        for table in TABLES:
            conn.execute(text(f"DELETE FROM {table}"))
        print("After:")
        print_counts(conn)
    print("LDC Master cleared. Hard-refresh the browser (Ctrl+Shift+R) before pulling from the SAP API.")


if __name__ == "__main__":
    main()
