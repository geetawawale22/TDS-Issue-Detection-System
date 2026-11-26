"""TDS analysis of a SAP data API pull as a background job, in batches.

A daily pull is several lakh vendor line items. Analysing them in one go
held everything in memory at once (about 2 GB per 75k rows, then the whole
result again as one JSON response), so a 3.7 lakh pull ran out of memory and
the backend died. This job:

1. Fetches every page into a temporary file on disk, not memory.
2. Cuts the rows into batches of at most BATCH_ROWS that share no vendor,
   PAN or document. Everything the rules compare across rows (a PAN's
   threshold, a certificate's limit, a vendor's advances, an invoice and its
   credit memo or clearing) stays inside one batch. The one check that looks
   across vendors (a GL's usual TDS pattern, for "Possible Missed TDS
   Deduction") is worked out over the whole pull first and handed to each
   batch, so the result is the same as analysing the pull in one go.
3. Analyses and saves one batch at a time under a single rule run, so
   memory stays at about one batch whatever the pull size.

A pull no larger than one batch is analysed exactly as before and its full
result goes to the browser. A larger one is only saved: the browser gets
the totals and reads issues and lines from the server.

The browser starts the job, then polls it (api/sap_data.py), so no request
has to stay open for the whole run.
"""

from __future__ import annotations

import logging
import math
import os
import pickle
import shutil
import tempfile
import threading
import time
from array import array
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Iterator
from uuid import uuid4

import pandas as pd
from fastapi import HTTPException

from db.database import SessionLocal
from db.models import LDCCertificateMaster, RuleRun, TrackedIssue, User, VendorMaster
from ingestion.sap_translator import _row_reader
from services import sap_data_api
from services.sap_data_api import MAX_PAGE_SIZE, SapDataApiError

logger = logging.getLogger(__name__)

# Rows analysed at once. ~75k rows needed ~1.5 GB without the browser copy.
BATCH_ROWS = int(os.getenv("SAP_ANALYSIS_BATCH_ROWS") or 50_000)
# Safety cap on one pull; the rows wait on disk, so this is not a memory limit.
MAX_ROWS = int(os.getenv("SAP_ANALYSIS_MAX_ROWS") or 3_000_000)
PAGE_ATTEMPTS = 3
# Rows written to a batch file at a time while sorting pages into batches.
_SPOOL_CHUNK = 5_000
# Set on rows while the GL pattern is learnt, to know each row's place in the pull.
_ROW_SEQ = "__tds_pull_row__"

ACTIVE = {"queued", "fetching", "grouping", "analysing", "finishing"}


class JobBusy(Exception):
    def __init__(self, job: "AnalysisJob"):
        super().__init__("Another SAP analysis is running.")
        self.job = job


class _Stopped(Exception):
    pass


class _JobError(Exception):
    """Fails the job with this message (shown to the user as is)."""


@dataclass
class AnalysisJob:
    id: str
    user_id: int
    table: str
    other_conditions: str
    company_code: str
    include_informational: bool
    status: str = "queued"
    stage: str = "Waiting to start"
    pages_fetched: int = 0
    rows_fetched: int = 0
    expected_rows: int | None = None
    batches_total: int = 0
    batches_done: int = 0
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    error: str | None = None
    stop_requested: bool = False
    # Rule run the batches are saved under (set by the first saved batch).
    run_id: int | None = None
    # Totals for the browser (same shape as an analysis result, without rows).
    summary: dict[str, Any] | None = None
    # Full analysis result (JSON bytes) when the pull fit in one batch.
    result: bytes | None = field(default=None, repr=False)

    def public(self) -> dict[str, Any]:
        return {
            "jobId": self.id,
            "status": self.status,
            "stage": self.stage,
            "table": self.table,
            "pagesFetched": self.pages_fetched,
            "rowsFetched": self.rows_fetched,
            "expectedRows": self.expected_rows,
            "batchesTotal": self.batches_total,
            "batchesDone": self.batches_done,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "elapsedSeconds": round((self.finished_at or time.time()) - self.started_at),
            "error": self.error,
            "hasFullResult": self.result is not None,
            "summary": self.summary,
        }


_jobs: dict[str, AnalysisJob] = {}
_lock = threading.Lock()
_KEEP_FINISHED = 5


def start_job(user: User, *, table: str, other_conditions: str, company_code: str, include_informational: bool) -> AnalysisJob:
    """Queue a pull and start it in the background. One at a time: raises JobBusy."""
    with _lock:
        running = next((job for job in _jobs.values() if job.status in ACTIVE), None)
        if running is not None:
            raise JobBusy(running)
        finished = sorted((job for job in _jobs.values()), key=lambda job: job.started_at)
        for old in finished[:-(_KEEP_FINISHED - 1) or None]:
            _jobs.pop(old.id, None)
        for old in _jobs.values():
            old.result = None  # only the newest pull's full result is kept
        job = AnalysisJob(
            id=uuid4().hex, user_id=user.id, table=table, other_conditions=other_conditions,
            company_code=company_code, include_informational=include_informational,
        )
        _jobs[job.id] = job
    threading.Thread(target=_run, args=(job,), name=f"sap-analysis-{job.id[:8]}", daemon=True).start()
    return job


def get_job(job_id: str) -> AnalysisJob | None:
    return _jobs.get(job_id)


def latest_job() -> AnalysisJob | None:
    return max(_jobs.values(), key=lambda job: job.started_at, default=None)


def stop_job(job_id: str) -> AnalysisJob | None:
    job = _jobs.get(job_id)
    if job is not None and job.status in ACTIVE:
        job.stop_requested = True
        job.stage = "Stopping after the current step…"
    return job


# ---------------------------------------------------------------- the job

def _run(job: AnalysisJob) -> None:
    workdir = tempfile.mkdtemp(prefix="tds-sap-pull-")
    try:
        _analyse_pull(job, workdir)
        job.status = "done"
    except _Stopped:
        job.status = "stopped"
        job.error = (
            f"Stopped. {job.batches_done} of {job.batches_total} batches were analysed and saved."
            if job.batches_done else "Stopped before anything was saved."
        )
    except _JobError as exc:
        job.status = "failed"
        job.error = str(exc)
    except HTTPException as exc:
        job.status = "failed"
        job.error = _saved_note(job, exc.detail if isinstance(exc.detail, str) else str(exc.detail))
    except SapDataApiError as exc:
        job.status = "failed"
        job.error = exc.message
    except MemoryError:
        logger.exception("SAP analysis job %s ran out of memory", job.id)
        job.status = "failed"
        job.error = _saved_note(job, f"The server ran out of memory. Set SAP_ANALYSIS_BATCH_ROWS lower than {BATCH_ROWS} in backend/.env and restart.")
    except Exception as exc:  # noqa: BLE001 - reported to the user, details in the log
        logger.exception("SAP analysis job %s failed", job.id)
        job.status = "failed"
        job.error = _saved_note(job, f"The analysis failed: {exc.__class__.__name__}: {str(exc)[:300]}. The backend console has the details.")
    finally:
        if job.status != "done" and job.run_id is not None:
            _refresh_partial_run(job)
        job.finished_at = time.time()
        if job.status == "done":
            job.stage = "Done"
        shutil.rmtree(workdir, ignore_errors=True)


def _refresh_partial_run(job: AnalysisJob) -> None:
    """Batches saved before a stop or failure still get their ledger issue flags."""
    from services.ledger_store import refresh_issue_state

    try:
        with SessionLocal() as db:
            run = db.get(RuleRun, job.run_id)
            companies = sorted({"" if code == "—" else code for code in (run.company_codes or "").split(",") if code}) if run else []
            refresh_issue_state(db, companies)
    except Exception:  # noqa: BLE001 - the job already failed; keep its message
        logger.exception("Refreshing ledger issue flags after SAP analysis job %s stopped", job.id)


def _saved_note(job: AnalysisJob, message: str) -> str:
    if job.batches_total > 1 and job.batches_done:
        return f"{message} ({job.batches_done} of {job.batches_total} batches were saved before this.)"
    return message


def _check_stop(job: AnalysisJob) -> None:
    if job.stop_requested:
        raise _Stopped()


def _analyse_pull(job: AnalysisJob, workdir: str) -> None:
    # Imported here: api.issues imports a lot and this module is imported by the router.
    from api.issues import _FastJSONResponse, run_analysis

    pages_path = os.path.join(workdir, "pages.pkl")
    grouper = _Grouper()
    page_nodes: list[array] = []
    job.status, job.stage = "fetching", "Fetching rows from SAP"
    with open(pages_path, "wb") as out:
        for rows in _fetch_pages(job):
            nodes = array("q", (grouper.add_row(row) for row in rows))
            pickle.dump(rows, out, protocol=pickle.HIGHEST_PROTOCOL)
            page_nodes.append(nodes)
            _check_stop(job)
    if not job.rows_fetched:
        raise _JobError("No rows match these filters, so there is nothing to process.")

    label = f"SAP API · {job.table}"
    common = dict(
        filename=label, filenames=[label], company_code=job.company_code,
        include_informational=job.include_informational, source="sap_api",
    )

    if job.rows_fetched <= BATCH_ROWS:
        # Small enough for one go: exactly the old path, full result for the browser.
        job.status, job.stage = "analysing", "Analysing"
        job.batches_total = 1
        rows = [row for rows in _read_pages(pages_path) for row in rows]
        with SessionLocal() as db:
            result = run_analysis(_frame(rows), current_user=_user(db, job), db=db, **common)
        del rows
        job.batches_done = 1
        job.result = _FastJSONResponse(content=result).body
        job.summary = _summary_from_result(result)
        return

    job.status, job.stage = "grouping", "Grouping rows by vendor / PAN / document"
    grouper.link_references()
    with SessionLocal() as db:
        grouper.link_master_data(db)
    batch_of_root = grouper.batches(BATCH_ROWS)
    job.batches_total = max(batch_of_root.values(), default=-1) + 1
    batch_paths = _spool_batches(pages_path, page_nodes, grouper, batch_of_root, workdir, job.batches_total)
    del page_nodes, grouper, batch_of_root
    os.remove(pages_path)
    _check_stop(job)

    # Whole-pull facts each batch needs (see module docstring).
    job.status = "analysing"
    with SessionLocal() as db:
        user = _user(db, job)
        job.stage = "Checking section formats"
        descriptive = _pull_uses_descriptive_sections(batch_paths, job, user, db)
        job.stage = "Learning each GL's TDS pattern"
        gl_stats = _pull_gl_stats(batch_paths, job, user, db, descriptive)
    _check_stop(job)

    from api.issues import AnalysisBatch

    batch = AnalysisBatch(descriptive=descriptive, gl_stats=gl_stats)
    totals = _Totals()
    for index, path in enumerate(batch_paths):
        _check_stop(job)
        job.stage = f"Analysing batch {index + 1} of {len(batch_paths)}"
        rows = [row for _, row in _read_batch(path)]
        with SessionLocal() as db:
            result = run_analysis(_frame(rows), current_user=_user(db, job), db=db, batch=batch, **common)
        del rows
        if result is not None:
            batch.run_id = job.run_id = result["tracking"]["runId"]
            totals.add(result)
        job.batches_done = index + 1
        os.remove(path)

    if batch.run_id is None:
        raise _JobError("No TDS-relevant transactions were found. Ensure TDS_Section and TDS_Rate are populated.")
    job.status, job.stage = "finishing", "Updating Document / GL Ledger issue flags"
    with SessionLocal() as db:
        job.summary = totals.summary(db, batch.run_id, job)


def _user(db, job: AnalysisJob) -> User:
    user = db.get(User, job.user_id)
    if user is None:
        raise _JobError("The user who started this pull no longer exists.")
    return user


# ---------------------------------------------------------------- fetching

def _fetch_pages(job: AnalysisJob) -> Iterator[list[dict[str, Any]]]:
    """Every page of the pull, like sap_data_api.fetch_all, retrying a failed page."""
    page_no = 1
    previous_first = None
    while True:
        job.stage = f"Fetching page {page_no} from SAP"
        page = _query_with_retry(job, page_no)
        # An API that ignores PageNo would return page 1 forever.
        if page.rows and page_no > 1 and page.rows[0] == previous_first:
            return
        total = sap_data_api._total(page.meta)
        if total is not None:
            job.expected_rows = total
        if page.rows:
            job.rows_fetched += len(page.rows)
            job.pages_fetched = page_no
            if job.rows_fetched > MAX_ROWS:
                raise _JobError(
                    f"More than {MAX_ROWS:,} rows match these filters. Narrow them (company code, date range) and try again."
                )
            yield page.rows
        if len(page.rows) < MAX_PAGE_SIZE or not page.rows or (total is not None and job.rows_fetched >= total):
            return
        previous_first = page.rows[0]
        page_no += 1


def _query_with_retry(job: AnalysisJob, page_no: int):
    for attempt in range(1, PAGE_ATTEMPTS + 1):
        try:
            return sap_data_api.query(job.table, page_no, MAX_PAGE_SIZE, job.other_conditions)
        except SapDataApiError as exc:
            # A rejected token or a bad filter will not fix itself.
            if exc.status_code in (400, 401, 403, 404, 422) or attempt == PAGE_ATTEMPTS:
                raise SapDataApiError(f"Page {page_no}: {exc.message}", exc.status_code) from exc
            job.stage = f"Page {page_no} failed ({exc.message[:80]}); retrying ({attempt + 1}/{PAGE_ATTEMPTS})"
            time.sleep(5 * attempt)
            _check_stop(job)
    raise AssertionError("unreachable")


def _read_pages(path: str) -> Iterator[list[dict[str, Any]]]:
    with open(path, "rb") as source:
        while True:
            try:
                yield pickle.load(source)
            except EOFError:
                return


def _read_batch(path: str) -> list[tuple[int, dict[str, Any]]]:
    rows: list[tuple[int, dict[str, Any]]] = []
    for chunk in _read_pages(path):
        rows.extend(chunk)
    return rows


def _blank(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, float) and math.isnan(value):
        return True
    return isinstance(value, str) and not value.strip()


def _frame(rows: list[dict[str, Any]], seq: list[int] | None = None) -> pd.DataFrame:
    """API rows as the analysis reads them (same as api/sap_data._fetch_frame).

    Values are kept as the API sent them (no type guessing per column), so a
    row reads the same whichever batch it is in. Fully empty rows are
    dropped here (the analysis drops them anyway), so ``seq`` stays aligned.
    """
    kept = [i for i, row in enumerate(rows) if not all(_blank(value) for value in row.values())]
    frame = pd.DataFrame([rows[i] for i in kept], dtype=object)
    frame.columns = [str(column).strip() for column in frame.columns]
    frame = frame.replace(r"^\s*$", None, regex=True)
    if seq is not None:
        # Each row's place in the pull, read back by _pull_gl_stats; the
        # translators ignore unknown columns.
        frame[_ROW_SEQ] = [seq[i] for i in kept]
    return frame


# ---------------------------------------------------------------- batching

def _doc_key(value: Any) -> str:
    text = str(value or "").strip().upper()
    return text.lstrip("0") or text


class _Grouper:
    """Union-find over vendors, PANs and documents: rows that a rule could
    compare (same vendor or PAN, or documents that point at each other) end
    up in one group, and groups are packed into batches."""

    def __init__(self) -> None:
        self.ids: dict[tuple, int] = {}
        self.parent: list[int] = []
        self.size: list[int] = []  # rows per group root
        # Rows pointing at another document (reference / clearing / reversal),
        # linked once every page is in: only to documents the pull contains.
        self.ref_ids: dict[tuple, int] = {}
        self.pending_nodes = array("q")
        self.pending_refs = array("q")

    def _node(self, key: tuple) -> int:
        node = self.ids.get(key)
        if node is None:
            node = self.ids[key] = len(self.parent)
            self.parent.append(node)
            self.size.append(0)
        return node

    def find(self, node: int) -> int:
        root = node
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[node] != root:
            self.parent[node], node = root, self.parent[node]
        return root

    def union(self, a: int, b: int) -> int:
        a, b = self.find(a), self.find(b)
        if a == b:
            return a
        if self.size[a] < self.size[b]:
            a, b = b, a
        self.parent[b] = a
        self.size[a] += self.size[b]
        return a

    def add_row(self, row: dict[str, Any]) -> int:
        get = _row_reader(row)
        company = str(get("company_code") or "").strip()
        keys: list[tuple] = []
        doc = _doc_key(get("doc_number"))
        if doc:
            keys.append(("D", company, doc))
        refs = []
        for name in ("invoice_reference_document", "clearing_document", "reversal_document", "advance_document_reference"):
            other = _doc_key(get(name))
            if other and other != doc:
                refs.append(("D", company, other))
        vendor = str(get("vendor_code") or "").strip()
        if vendor:
            keys.append(("V", vendor))
        pan = str(get("pan") or "").strip().upper()
        if pan:
            # A PAN column holding a vendor code is read as one (see _apply_ldc_master_to_transactions).
            keys.append(("P", pan) if _looks_like_pan(pan) else ("V", pan))
        if not keys:
            keys.append(("ROW", len(self.parent)))  # nothing to link on: a group of its own
        root = self._node(keys[0])
        for key in keys[1:]:
            root = self.union(root, self._node(key))
        root = self.find(root)
        self.size[root] += 1
        for ref in refs:
            self.pending_nodes.append(root)
            self.pending_refs.append(self.ref_ids.setdefault(ref, len(self.ref_ids)))
        return root

    def link_references(self) -> None:
        """A row and the document it points at go together, when that
        document is in the pull. A value that is no document here (SAP
        extracts carry fillers like "V" on hundreds of vendors) links
        nothing; rows pointing at the same missing document still share
        their vendor."""
        keys = list(self.ref_ids)
        for node, ref in zip(self.pending_nodes, self.pending_refs):
            target = self.ids.get(keys[ref])
            if target is not None:
                self.union(node, target)
        self.ref_ids.clear()
        self.pending_nodes = array("q")
        self.pending_refs = array("q")

    def link_master_data(self, db) -> None:
        """Vendor codes whose PAN comes from the vendor master or an LDC
        certificate (the analysis fills or matches it from there)."""
        vendors = [key[1] for key in self.ids if key[0] == "V"]
        for start in range(0, len(vendors), 1000):
            chunk = vendors[start:start + 1000]
            for code, pan in db.query(VendorMaster.vendor_code, VendorMaster.vendor_pan).filter(
                VendorMaster.vendor_code.in_(chunk), VendorMaster.is_active == True,  # noqa: E712
            ):
                self._join(("V", code), pan)
            for code, pan in db.query(LDCCertificateMaster.vendor_code, LDCCertificateMaster.vendor_pan).filter(
                LDCCertificateMaster.vendor_code.in_(chunk),
            ):
                self._join(("V", code), pan)

    def _join(self, vendor_key: tuple, pan: Any) -> None:
        pan = str(pan or "").strip().upper()
        if not pan or vendor_key not in self.ids:
            return
        other = ("P", pan) if _looks_like_pan(pan) else ("V", pan)
        if other in self.ids:
            self.union(self.ids[vendor_key], self.ids[other])

    def batches(self, limit: int) -> dict[int, int]:
        """Group root -> batch number. Biggest groups first, each into the
        first batch with room; a group bigger than ``limit`` gets its own."""
        roots = sorted(
            {self.find(node) for node in range(len(self.parent))},
            key=lambda root: -self.size[root],
        )
        loads: list[int] = []
        batch_of_root: dict[int, int] = {}
        for root in roots:
            rows = self.size[root]
            if not rows:
                continue
            for index, load in enumerate(loads):
                if load + rows <= limit:
                    loads[index] += rows
                    batch_of_root[root] = index
                    break
            else:
                loads.append(rows)
                batch_of_root[root] = len(loads) - 1
        return batch_of_root


def _looks_like_pan(value: str) -> bool:
    from api.issues import _looks_like_pan as looks_like_pan

    return looks_like_pan(value)


def _spool_batches(pages_path, page_nodes, grouper, batch_of_root, workdir, count) -> list[str]:
    """Write each batch's rows (with their place in the pull) to its own file, in pull order."""
    paths = [os.path.join(workdir, f"batch-{index:04d}.pkl") for index in range(count)]
    outputs = [open(path, "wb") for path in paths]
    buffers: dict[int, list] = defaultdict(list)
    try:
        seq = 0
        for rows, nodes in zip(_read_pages(pages_path), page_nodes):
            for row, node in zip(rows, nodes):
                index = batch_of_root[grouper.find(node)]
                buffer = buffers[index]
                buffer.append((seq, row))
                seq += 1
                if len(buffer) >= _SPOOL_CHUNK:
                    pickle.dump(buffer, outputs[index], protocol=pickle.HIGHEST_PROTOCOL)
                    buffers[index] = []
        for index, buffer in buffers.items():
            if buffer:
                pickle.dump(buffer, outputs[index], protocol=pickle.HIGHEST_PROTOCOL)
    finally:
        for output in outputs:
            output.close()
    return paths


# ---------------------------------------------------------------- whole-pull facts

def _batch_records(path, job, user, db, with_seq: bool = False):
    from api.issues import prepare_records

    pairs = _read_batch(path)
    seq = [number for number, _ in pairs] if with_seq else None
    frame = _frame([row for _, row in pairs], seq)
    del pairs
    records, _, _ = prepare_records(frame, company_code=job.company_code, current_user=user, db=db)
    return records


def _pull_uses_descriptive_sections(paths, job, user, db) -> bool:
    from api.issues import uses_descriptive_sections

    for path in paths:
        _check_stop(job)
        if uses_descriptive_sections(_batch_records(path, job, user, db)):
            return True
    return False


def _pull_gl_stats(paths, job, user, db, descriptive: bool) -> dict[tuple, dict]:
    """rules.missing_deduction_gl_stats over the whole pull, batch by batch."""
    from api.issues import (
        _apply_ldc_master_to_transactions,
        _apply_pan_verification_to_transactions,
        _has_zero_base_amount,
        _is_skipped_non_tds_document_without_tds_amounts,
        build_transactions,
        missing_deduction_inputs,
    )
    from rules.tds_rule_engine import missing_deduction_gl_stats

    merged: dict[tuple, dict] = {}
    for path in paths:
        _check_stop(job)
        records = _batch_records(path, job, user, db, with_seq=True)
        transactions, seq_of = [], {}
        for record in records:
            # One row at a time only to know which row each transaction came
            # from; the translators handle rows one by one anyway.
            for txn in build_transactions([record], descriptive):
                transactions.append(txn)
                seq_of[id(txn)] = record[_ROW_SEQ]
        del records
        _apply_ldc_master_to_transactions(transactions, db)
        _apply_pan_verification_to_transactions(transactions, db)
        eligible = {
            id(txn) for txn in transactions
            if not _is_skipped_non_tds_document_without_tds_amounts(txn) and not _has_zero_base_amount(txn)
        }
        # check_missing_deduction takes eligible rows first, then the rest, in pull order.
        order = lambda txn: (0 if id(txn) in eligible else 1, seq_of[id(txn)])  # noqa: E731
        for key, stats in missing_deduction_gl_stats(missing_deduction_inputs(transactions), order).items():
            into = merged.get(key)
            if into is None:
                merged[key] = stats
                continue
            into["total"] += stats["total"]
            into["with_tds"] += stats["with_tds"]
            if stats["sample_order"] is not None and (into["sample_order"] is None or stats["sample_order"] < into["sample_order"]):
                for name in ("sample_section", "sample_rate", "sample_order"):
                    into[name] = stats[name]
        db.rollback()  # the LDC / PAN lookups only read
    return merged


# ---------------------------------------------------------------- totals

_TRACKING_COUNTS = ("newIssues", "recurringIssues", "reopenedIssues", "resolvedIssues", "partiallyCorrected")


class _Totals:
    def __init__(self) -> None:
        self.stats: dict[str, float] = defaultdict(int)
        self.tracking: dict[str, int] = defaultdict(int)
        self.resolved_by_type: dict[str, int] = defaultdict(int)
        self.ledger: dict[str, int] = defaultdict(int)
        self.vendors: set[str] = set()
        self.sections: set[str] = set()
        self.ldc_utilization: list[dict[str, Any]] = []
        self.financial_years: dict[str, int] = defaultdict(int)
        self.first: dict[str, Any] | None = None

    def add(self, result: dict[str, Any]) -> None:
        self.first = self.first or {key: result[key] for key in ("fileName", "fileNames", "companyCode")}
        stats = result["stats"]
        for key, value in stats.items():
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                self.stats[key] += value
        if "openIssues" not in stats:
            self.stats["openIssues"] += stats.get("issuesFound", 0)
        tracking = result.get("tracking") or {}
        for key in _TRACKING_COUNTS:
            self.tracking[key] += tracking.get(key, 0) or 0
        for key, value in (tracking.get("resolvedByType") or {}).items():
            self.resolved_by_type[key] += value
        for key, value in (tracking.get("ledger") or {}).items():
            self.ledger[key] += value
        self.vendors.update(result.get("vendors") or [])
        self.sections.update(result.get("sections") or [])
        self.ldc_utilization.extend(result.get("ldcUtilization") or [])
        for label, count in (result.get("financialYearCounts") or {}).items():
            self.financial_years[label] += count

    def summary(self, db, run_id: int, job: AnalysisJob) -> dict[str, Any]:
        from services.ledger_store import refresh_issue_state

        run = db.get(RuleRun, run_id)
        companies = sorted({"" if code == "—" else code for code in (run.company_codes or "").split(",") if code})
        # Batches left the company-wide ledger issue flags to here.
        refresh_issue_state(db, companies)
        open_in_scope = db.query(TrackedIssue).filter(TrackedIssue.status == "open", TrackedIssue.company_code.in_(companies))
        total_open = open_in_scope.count()
        carried_open = open_in_scope.filter(
            (TrackedIssue.last_seen_run_id != run_id) | TrackedIssue.last_seen_run_id.is_(None)
        ).count()
        return {
            "uploadId": job.id,
            **(self.first or {}),
            "serverOnly": True,
            "financialYear": max(self.financial_years, key=self.financial_years.get, default=None),
            "issues": [],
            "stats": dict(self.stats),
            "vendors": sorted(self.vendors),
            "sections": sorted(self.sections),
            "thresholdVendors": [],
            "ldcUtilization": self.ldc_utilization,
            "tdsCases": [],
            "caseStats": {},
            "caseLedger": [],
            "validationRows": [],
            "unrecognizedColumns": [],
            "errors": [],
            "tracking": {
                "runId": run_id,
                **dict(self.tracking),
                "resolvedByType": {key: value for key, value in self.resolved_by_type.items() if value},
                "carriedForwardOpen": carried_open,
                "totalOpen": total_open,
                "ledger": dict(self.ledger),
                "batches": job.batches_total,
            },
        }


def _summary_from_result(result: dict[str, Any]) -> dict[str, Any]:
    """Totals of a one-batch pull (its full result is fetched separately)."""
    return {
        "stats": result.get("stats") or {},
        "tracking": result.get("tracking") or {},
        "fileName": result.get("fileName"),
    }
