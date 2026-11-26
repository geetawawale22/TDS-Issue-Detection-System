"""Clear all TDS analysis data so a fresh file / SAP API pull starts from zero.

Deletes every analysis run and what it produced: tracked issues (Open /
Resolved issues, Dashboard), Document / GL Ledger lines and groups, the
TDS Category Report rows saved with them, and the Correction Register.
Master data stays: LDC Master, vendor master, PAN verifications, users,
company codes. Uses DATABASE_URL from backend/.env (PostgreSQL or MySQL).

    python clear_analysis.py                     # everything above
    python clear_analysis.py --keep-corrections  # keep the Correction Register
"""
import sys
from pathlib import Path

# Run from any folder: make the backend packages importable.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from sqlalchemy import text  # noqa: E402

from db.database import engine  # noqa: E402

# Children before parents (foreign keys to rule_runs / correction_groups).
CORRECTION_TABLES = ["correction_entries", "correction_groups"]
ANALYSIS_TABLES = ["upload_rows", "ledger_groups", "ledger_lines", "tracked_issues", "rule_runs"]

TABLES = ([] if "--keep-corrections" in sys.argv else CORRECTION_TABLES) + ANALYSIS_TABLES


def print_counts(conn):
    for table in TABLES:
        count = conn.execute(text(f"SELECT COUNT(*) FROM {table}")).scalar()
        print(f"  {table}: {count}")


def main():
    with engine.begin() as conn:
        print(f"Database: {engine.url.render_as_string(hide_password=True)}")
        print("Before:")
        print_counts(conn)
        answer = input("Delete all rows from these tables? (y/n): ")
        if answer.strip().lower() not in {"y", "yes"}:
            print("Cancelled, nothing deleted.")
            return
        for table in TABLES:
            conn.execute(text(f"DELETE FROM {table}"))
        print("After:")
        print_counts(conn)
    print("Analysis data cleared. Reload the app: browsers holding the old upload drop it on their own.")


if __name__ == "__main__":
    main()
