import { useMemo, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import toast from 'react-hot-toast'
import {
  Download, FileSearch, SlidersHorizontal, RotateCcw,
  AlertOctagon, AlertTriangle, CheckCircle2, CheckCheck, IdCard, Loader2, CircleSlash,
} from 'lucide-react'
import DataTable from '@/components/Common/DataTable'
import StatusBadge, { severityToTone, issueStatusToTone } from '@/components/Common/StatusBadge'
import IssueDrawer from '@/components/Common/IssueDrawer'
import SapUploadPanel from '@/components/Common/SapUploadPanel'
import LiveDataBadge from '@/components/Common/LiveDataBadge'
import {
  setSearchQuery, setVendorFilter, setSectionFilter, setSeverityFilter,
  setStatusFilter, setIssueTypeFilter, openDrawer, closeDrawer, resetFilters,
  selectActiveIssues, selectActiveVendors, selectActiveSections, selectActiveValidationRows,
} from '@/redux/slices/issuesSlice'
import { startVerifyPan, finishVerifyPan } from '@/redux/slices/panSlice'
import { issueTypeFilterOptions, getDisplayIssueType, simulatePanVerification, MULTI_CATEGORY_DELIMITER } from '@/data/issueTypes'
import { formatCurrency, formatStatusLabel } from '@/utils/utils'
import '@/components/Common/Common.css'
import './Issues.css'

const SEVERITY_OPTIONS = [['all','All Severity'],['high','High'],['medium','Medium'],['low','Low']]
const STATUS_OPTIONS   = [['all','All Status'],['open','Open'],['in_review','In Review'],['resolved','Resolved'],['rejected','Rejected']]
const ISSUE_TYPE_OPTIONS = issueTypeFilterOptions()

const SEVERITY_ICON = { high: AlertOctagon, medium: AlertTriangle, low: CheckCircle2 }
const DEFAULT_SECTION_RATES = {
  '194C': 1,
  '194H': 5,
  '194Q': 0.1,
}

function inferRateFromAmount(baseAmount, tdsAmount) {
  const base = Number(baseAmount) || 0
  const tds = Math.abs(Number(tdsAmount) || 0)
  if (base <= 0 || tds <= 0) return null
  return Number(((tds / base) * 100).toFixed(4))
}

function normaliseRateForDisplay(rate) {
  if (rate == null) return null
  const rounded = Number(Number(rate).toFixed(4))
  return Math.abs(rounded - 2) <= 0.05 ? 2
    : Math.abs(rounded - 10) <= 0.05 ? 10
    : Math.abs(rounded - 1) <= 0.05 ? 1
    : Math.abs(rounded - 0.1) <= 0.01 ? 0.1
    : rounded
}

function SectionCell({ issue }) {
  const oldSection = issue.legacySection || issue.ruleSection
  const newSection = issue.newSection
  const hasOldAndNew = oldSection && newSection && oldSection !== newSection

  if (!hasOldAndNew) {
    return <span className="font-mono issues-section-single">{issue.section}</span>
  }

  return (
    <span className="font-mono issues-section-stack" title={`${oldSection} /${newSection}`}>
      <span>{oldSection} /</span>
      <span>{newSection}</span>
    </span>
  )
}

export default function Issues() {
  const dispatch = useDispatch()
  const [validationView, setValidationView] = useState('issue')
  const [reviewValidationRow, setReviewValidationRow] = useState(null)
  const {
    searchQuery, vendorFilter, sectionFilter, severityFilter, statusFilter,
    issueTypeFilter, selectedIssueId, drawerOpen, dataSource, uploadMeta,
  } = useSelector((s) => s.issues)

  const issues = useSelector(selectActiveIssues)
  const activeValidationRows = useSelector(selectActiveValidationRows)
  const vendorNames = useSelector(selectActiveVendors)
  const sections = useSelector(selectActiveSections)

  // PAN is verified for every vendor in the loaded issue set at once, not
  // per-issue (see IssueDrawer, which just displays the result) — this
  // mirrors how a real bulk PAN-verification API call would work: one
  // request per vendor, not one per issue row.
  const [bulkVerifying, setBulkVerifying] = useState(false)

  function handleVerifyAllPans() {
    if (bulkVerifying) return
    const vendorPanMap = new Map()
    for (const issue of issues) {
      if (issue.vendorId && issue.vendorId !== '—' && !vendorPanMap.has(issue.vendorId)) {
        vendorPanMap.set(issue.vendorId, issue.vendorPan)
      }
    }
    const vendorIds = [...vendorPanMap.keys()]
    if (vendorIds.length === 0) {
      toast('No vendors to verify')
      return
    }
    setBulkVerifying(true)
    vendorIds.forEach((id) => dispatch(startVerifyPan(id)))
    // Simulate the latency of a real bulk government PAN API round-trip.
    setTimeout(() => {
      let active = 0, inactive = 0, invalid = 0
      vendorIds.forEach((vendorId) => {
        const result = simulatePanVerification(vendorPanMap.get(vendorId))
        dispatch(finishVerifyPan({ vendorId, result: { ...result, checkedAt: new Date().toISOString() } }))
        if (result.status === 'Active') active++
        else if (result.status === 'Inactive') inactive++
        else invalid++
      })
      setBulkVerifying(false)
      toast.success(
        `Verified ${vendorIds.length} vendor PAN${vendorIds.length === 1 ? '' : 's'} — ${active} active`
        + (inactive ? `, ${inactive} inactive` : '')
        + (invalid ? `, ${invalid} invalid format` : ''),
      )
    }, 900)
  }

  const filtered = useMemo(() => issues.filter((issue) => {
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      if (
        !issue.vendor?.toLowerCase().includes(q) &&
        !issue.id?.toLowerCase().includes(q) &&
        !String(issue.docNo ?? '').toLowerCase().includes(q) &&
        !String(issue.vendorId ?? '').toLowerCase().includes(q) &&
        !String(issue.section ?? '').toLowerCase().includes(q)
      ) return false
    }
    if (vendorFilter    !== 'all' && issue.vendor    !== vendorFilter)    return false
    if (sectionFilter   !== 'all' && issue.section   !== sectionFilter)   return false
    if (severityFilter  !== 'all' && issue.severity  !== severityFilter)  return false
    if (statusFilter    !== 'all' && issue.status    !== statusFilter)    return false
    if (issueTypeFilter !== 'all' && !issueTypeFilter.split(MULTI_CATEGORY_DELIMITER).includes(getDisplayIssueType(issue))) return false
    return true
  }), [issues, searchQuery, vendorFilter, sectionFilter, severityFilter, statusFilter, issueTypeFilter])

  const selectedIssue = issues.find((i) => i.id === selectedIssueId) ?? null

  // Company/FY-scoped validation rows (see selectActiveValidationRows), with
  // one extra reclassification: a row with a zero base amount can't actually
  // be rate-checked, so it reads as "insufficient data" rather than a false
  // "passed".
  const adjustedValidationRows = useMemo(() => (
    activeValidationRows.map((row) => (
      Number(row.baseAmount) === 0
        ? {
          ...row,
          status: 'insufficient',
          reason: 'Base amount is zero, so TDS cannot be validated for this row.',
        }
        : row
    ))
  ), [activeValidationRows])
  const drawerIssue = reviewValidationRow || selectedIssue
  const drawerIsOpen = Boolean(reviewValidationRow) || drawerOpen

  function buildValidationReviewIssue(row) {
    const inferredRate = normaliseRateForDisplay(inferRateFromAmount(row.baseAmount, row.tdsAmount))
    const appliedRate = normaliseRateForDisplay(row.appliedRate ?? inferredRate)
    const expectedRate = row.section === '194J' && [2, 10].includes(appliedRate)
      ? appliedRate
      : normaliseRateForDisplay(row.expectedRate ?? inferredRate ?? DEFAULT_SECTION_RATES[row.section] ?? null)

    return {
      ...row,
      id: row.id || `PASSED-${row.docNo}`,
      category: 'Passed Validation',
      issueTypeLabel: 'Passed Validation',
      issueType: 'PASSED_VALIDATION',
      severity: 'low',
      status: 'open',
      plainEnglish: row.reason || 'Validated with no issue found.',
      recommendedAction: 'No correction required — this row passed the current validation rules.',
      expectedRate,
      appliedRate,
      taxImpact: 0,
    }
  }

  // Derived from adjustedValidationRows (already Company/FY-scoped, plus the
  // zero-base-amount reclassification above) rather than uploadMeta.stats
  // directly, so these cards can't drift out of sync with the table
  // underneath them once a Company/FY filter narrows what's shown. Skipped
  // rows are the one exception: a row that failed to become a transaction at
  // all never enters validationRows in the first place (so it was never
  // attributed to a company or date either) — that count always reflects the
  // whole upload, read straight from the backend stat.
  const summary = useMemo(() => {
    if (!uploadMeta) return { passedRows: 0, issueRows: issues.length, insufficientDataRows: 0, skippedRows: 0 }
    return {
      passedRows: adjustedValidationRows.filter((r) => r.status === 'passed').length,
      issueRows: adjustedValidationRows.filter((r) => r.status === 'issue').length,
      insufficientDataRows: adjustedValidationRows.filter((r) => r.status === 'insufficient').length,
      skippedRows: uploadMeta.stats?.rowsSkipped ?? 0,
    }
  }, [issues, uploadMeta, adjustedValidationRows])

  const columns = [
    { header: '#', render: (_r, i) => <span className="font-mono" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>{i + 1}</span> },
    { key: 'docNo',   header: 'Doc No.',  render: (r) => (
      <div>
        <span className="font-mono" style={{ fontSize: 11.5 }}>{r.docNo}</span>
        {r.status === 'resolved' ? (
          <div className="corrected-badge"><CheckCheck size={11} />Corrected</div>
        ) : r.status !== 'open' && (
          <div style={{ marginTop: 3 }}>
            <StatusBadge label={formatStatusLabel(r.status)} tone={issueStatusToTone(r.status)} />
          </div>
        )}
      </div>
    )},
    { key: 'vendor', header: 'Vendor',    render: (r) => (
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 500 }}>{r.vendor}</div>
        <div className="font-mono" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{r.vendorId}</div>
      </div>
    )},
    { key: 'section',      header: 'Section',  render: (r) => <SectionCell issue={r} /> },
    { key: 'baseAmount',   header: 'Base Amt', render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{formatCurrency(r.baseAmount)}</span> },
    { key: 'tdsAmount',    header: 'TDS (₹)',  render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{formatCurrency(r.tdsAmount)}</span> },
    { key: 'category', header: 'Issue Type', render: (r) => {
      const Icon = SEVERITY_ICON[r.severity] ?? AlertTriangle
      const displayType = getDisplayIssueType(r)
      return (
        <div className={`issue-type-cell issue-type-cell--${r.severity}`} title={displayType}>
          <Icon size={13} />
          <span className="issue-type-text">{displayType}</span>
        </div>
      )
    }},
    { key: 'severity', header: 'Severity', render: (r) => <StatusBadge label={formatStatusLabel(r.severity)} tone={severityToTone(r.severity)} /> },
    { header: '', render: (r) => (
      <button className="issues-review-btn" onClick={() => dispatch(openDrawer(r.id))}>Review</button>
    )},
  ]

  const validationColumns = [
    { header: '#', render: (_r, i) => <span className="font-mono" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>{i + 1}</span> },
    { key: 'docNo', header: 'Doc No.', render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{r.docNo}</span> },
    { key: 'vendor', header: 'Vendor', render: (r) => (
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 500 }}>{r.vendor}</div>
        <div className="font-mono" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{r.vendorId}</div>
      </div>
    )},
    { key: 'section', header: 'Section', render: (r) => <span className="font-mono issues-section-single">{r.section}</span> },
    { key: 'baseAmount', header: 'Base Amt', render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{formatCurrency(r.baseAmount)}</span> },
    { key: 'tdsAmount', header: 'TDS (₹)', render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{formatCurrency(r.tdsAmount)}</span> },
    { header: '', render: (r) => (
      r.status === 'passed'
        ? (
          <button
            className="issues-review-btn"
            type="button"
            onClick={() => setReviewValidationRow(buildValidationReviewIssue(r))}
          >
            Review
          </button>
        )
        : null
    )},
  ]

  // Search/Vendor/Section apply here too (those fields exist on a validation
  // row) — Severity/Issue Type/Status stay issue-table-only since a passed,
  // insufficient-data, or skipped row has neither a severity nor a category.
  const validationTableRows = useMemo(() => {
    if (validationView === 'issue') return []
    return adjustedValidationRows
      .filter((row) => {
        if (row.status !== validationView) return false
        if (searchQuery) {
          const q = searchQuery.toLowerCase()
          if (
            !row.vendor?.toLowerCase().includes(q) &&
            !String(row.docNo ?? '').toLowerCase().includes(q) &&
            !String(row.vendorId ?? '').toLowerCase().includes(q) &&
            !String(row.section ?? '').toLowerCase().includes(q)
          ) return false
        }
        if (vendorFilter  !== 'all' && row.vendor  !== vendorFilter)  return false
        if (sectionFilter !== 'all' && row.section !== sectionFilter) return false
        return true
      })
      .map((row, index) => ({ ...row, id: `${validationView}-${index}-${row.id || row.docNo || 'row'}` }))
  }, [adjustedValidationRows, validationView, searchQuery, vendorFilter, sectionFilter])

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="breadcrumb">
            <span>Home</span><span className="breadcrumb-sep">›</span>
            <span className="breadcrumb-current">Issues</span>
          </div>
          <h1 className="page-title">Issues</h1>
        </div>
        <div className="issues-header-actions">
          <LiveDataBadge />
          <button className="btn btn-outline" type="button" onClick={handleVerifyAllPans} disabled={bulkVerifying}>
            {bulkVerifying ? <Loader2 size={14} className="spin" /> : <IdCard size={14} />}
            {bulkVerifying ? 'Verifying PANs…' : 'Verify All PANs'}
          </button>
          <button className="btn btn-outline" type="button">
            <Download size={14} />Export
          </button>
        </div>
      </div>

      <SapUploadPanel />

      {/* Summary strip */}
      <div className="issues-summary-grid">
        <button
          className={`issues-summary-card issues-summary-card--success ${validationView === 'passed' ? 'issues-summary-card--active' : ''}`}
          type="button"
          onClick={() => setValidationView('passed')}
        >
          <CheckCircle2 size={16} />
          <div>
            <div className="issues-summary-value">{summary.passedRows.toLocaleString()}</div>
            <div className="issues-summary-label">Passed</div>
          </div>
        </button>
        <button
          className={`issues-summary-card issues-summary-card--danger ${validationView === 'issue' ? 'issues-summary-card--active' : ''}`}
          type="button"
          onClick={() => setValidationView('issue')}
        >
          <AlertOctagon size={16} />
          <div>
            <div className="issues-summary-value">{summary.issueRows.toLocaleString()}</div>
            <div className="issues-summary-label">Issue Found</div>
          </div>
        </button>
        <button
          className={`issues-summary-card issues-summary-card--warning ${validationView === 'insufficient' ? 'issues-summary-card--active' : ''}`}
          type="button"
          onClick={() => setValidationView('insufficient')}
        >
          <AlertTriangle size={16} />
          <div>
            <div className="issues-summary-value">{summary.insufficientDataRows.toLocaleString()}</div>
            <div className="issues-summary-label">Insufficient Data</div>
          </div>
        </button>
        <button
          className={`issues-summary-card issues-summary-card--neutral ${validationView === 'skipped' ? 'issues-summary-card--active' : ''}`}
          type="button"
          onClick={() => setValidationView('skipped')}
        >
          <CircleSlash size={16} />
          <div>
            <div className="issues-summary-value">{summary.skippedRows.toLocaleString()}</div>
            <div className="issues-summary-label">Skipped</div>
          </div>
        </button>
      </div>

      {/* Filter bar */}
      <div className="filter-bar">
        <div className="filter-bar-top">
          <div className="filter-bar-label">
            <SlidersHorizontal size={14} />Filters
          </div>
          <input
            className="filter-input"
            value={searchQuery}
            onChange={(e) => dispatch(setSearchQuery(e.target.value))}
            placeholder="Search vendor / doc / ID / section…"
          />
        </div>
        <div className="filter-bar-controls">
          <select className="filter-select" value={vendorFilter} onChange={(e) => dispatch(setVendorFilter(e.target.value))}>
            <option value="all">All Vendors</option>
            {vendorNames.slice(0, 40).map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
          <select className="filter-select" value={sectionFilter} onChange={(e) => dispatch(setSectionFilter(e.target.value))}>
            <option value="all">All Sections</option>
            {sections.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select
            className="filter-select"
            value={severityFilter}
            disabled={validationView !== 'issue'}
            title={validationView !== 'issue' ? 'Only applies to the Issues Found view' : undefined}
            onChange={(e) => dispatch(setSeverityFilter(e.target.value))}
          >
            {SEVERITY_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select
            className="filter-select"
            value={issueTypeFilter}
            disabled={validationView !== 'issue'}
            title={validationView !== 'issue' ? 'Only applies to the Issues Found view' : undefined}
            onChange={(e) => dispatch(setIssueTypeFilter(e.target.value))}
          >
            <option value="all">All Issue Types</option>
            {ISSUE_TYPE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select
            className="filter-select"
            value={statusFilter}
            disabled={validationView !== 'issue'}
            title={validationView !== 'issue' ? 'Only applies to the Issues Found view' : undefined}
            onChange={(e) => dispatch(setStatusFilter(e.target.value))}
          >
            {STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <button className="filter-reset-btn" onClick={() => dispatch(resetFilters())}>
            <RotateCcw size={12} />Reset
          </button>
        </div>
      </div>

      <div className="table-card">
        <div className="issues-count-label">
          {validationView === 'issue'
            ? `Showing ${filtered.length.toLocaleString()} issue${filtered.length === 1 ? '' : 's'}`
            : `Showing ${validationTableRows.length.toLocaleString()} ${validationView} row${validationTableRows.length === 1 ? '' : 's'}`}
          {dataSource === 'upload' ? ' from SAP upload' : ' awaiting SAP upload'}
        </div>
        {validationView === 'issue' ? (
          <DataTable
            key="issue-table"
            columns={columns}
            data={filtered}
            pageSize={50}
            emptyState={
              <div className="empty-state">
                <div className="empty-state-icon"><FileSearch size={20} /></div>
                <div className="empty-state-title">No issues match your filters</div>
                <div className="empty-state-desc">Try adjusting your search or filter criteria.</div>
                <button className="btn btn-outline btn-sm" onClick={() => dispatch(resetFilters())}>Reset Filters</button>
              </div>
            }
          />
        ) : (
          <DataTable
            key={`validation-table-${validationView}`}
            columns={validationColumns}
            data={validationTableRows}
            pageSize={50}
            emptyState={
              <div className="empty-state">
                <div className="empty-state-icon"><FileSearch size={20} /></div>
                <div className="empty-state-title">No rows in this bucket</div>
                <div className="empty-state-desc">This validation category has no rows in the latest SAP upload.</div>
              </div>
            }
          />
        )}
      </div>

      <IssueDrawer
        issue={drawerIssue}
        open={drawerIsOpen}
        onClose={() => {
          setReviewValidationRow(null)
          dispatch(closeDrawer())
        }}
      />
    </div>
  )
}
