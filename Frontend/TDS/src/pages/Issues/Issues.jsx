import { useEffect, useMemo, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import {
  Download, FileSearch, SlidersHorizontal, RotateCcw,
  Activity, AlertOctagon, AlertTriangle, CheckCircle2, CheckCheck, IdCard, Loader2, CircleSlash,
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
import { downloadCsv, ISSUE_CSV_COLUMNS, VALIDATION_CSV_COLUMNS } from '@/utils/csvExport'
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
const VIEW_LABELS = {
  all: 'All Transactions',
  issue: 'Issues Found',
  passed: 'Passed',
  insufficient: 'Insufficient Data',
  skipped: 'Skipped',
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
  const [searchParams] = useSearchParams()
  const [validationView, setValidationView] = useState('all')
  const [reviewValidationRow, setReviewValidationRow] = useState(null)
  const [docTypeFilter, setDocTypeFilter] = useState('all')
  const {
    searchQuery, vendorFilter, sectionFilter, severityFilter, statusFilter,
    issueTypeFilter, selectedIssueId, drawerOpen, dataSource, uploadMeta,
  } = useSelector((s) => s.issues)

  const issues = useSelector(selectActiveIssues)
  const activeValidationRows = useSelector(selectActiveValidationRows)
  const vendorNames = useSelector(selectActiveVendors)
  const sections = useSelector(selectActiveSections)
  const monthFilter = searchParams.get('month')

  function rowMonth(value) {
    if (!value) return null
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return null
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
  }

  useEffect(() => {
    const view = searchParams.get('view')
    const severity = searchParams.get('severity')
    const status = searchParams.get('status')
    const issueType = searchParams.get('type')
    const section = searchParams.get('section')
    const vendor = searchParams.get('vendor')

    dispatch(resetFilters())
    setDocTypeFilter('all')
    if (['all', 'issue', 'passed', 'insufficient', 'skipped'].includes(view)) {
      setValidationView(view)
    } else {
      setValidationView('all')
    }
    if (severity) dispatch(setSeverityFilter(severity))
    if (status) dispatch(setStatusFilter(status))
    if (issueType) dispatch(setIssueTypeFilter(issueType))
    if (section) dispatch(setSectionFilter(section))
    if (vendor) dispatch(setVendorFilter(vendor))
  }, [dispatch, searchParams])

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
    if (monthFilter && rowMonth(issue.date) !== monthFilter) return false
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      if (
        !issue.vendor?.toLowerCase().includes(q) &&
        !issue.id?.toLowerCase().includes(q) &&
        !String(issue.docNo ?? '').toLowerCase().includes(q) &&
        !String(issue.docType ?? '').toLowerCase().includes(q) &&
        !String(issue.vendorId ?? '').toLowerCase().includes(q) &&
        !String(issue.section ?? '').toLowerCase().includes(q) &&
        !String(issue.vendorPan ?? '').toLowerCase().includes(q)
      ) return false
    }
    if (vendorFilter    !== 'all' && issue.vendor    !== vendorFilter)    return false
    if (sectionFilter   !== 'all' && issue.section   !== sectionFilter)   return false
    if (docTypeFilter   !== 'all' && String(issue.docType ?? '').toUpperCase() !== docTypeFilter) return false
    if (severityFilter  !== 'all' && issue.severity  !== severityFilter)  return false
    if (statusFilter    !== 'all' && issue.status    !== statusFilter)    return false
    if (issueTypeFilter !== 'all') {
      const allowedTypes = issueTypeFilter.split(MULTI_CATEGORY_DELIMITER)
      const rowTypes = [getDisplayIssueType(issue), issue.category, issue.issueTypeLabel, issue.issueType].filter(Boolean)
      if (!rowTypes.some((type) => allowedTypes.includes(type))) return false
    }
    return true
  }), [issues, searchQuery, vendorFilter, sectionFilter, docTypeFilter, severityFilter, statusFilter, issueTypeFilter, monthFilter])

  const selectedIssue = issues.find((i) => i.id === selectedIssueId) ?? null

  // Company/FY-scoped validation rows (see selectActiveValidationRows), with
  // one extra reclassification: a row with a zero base amount can't actually
  // be rate-checked, so it reads as "insufficient data" rather than a false
  // "passed".
  const adjustedValidationRows = useMemo(() => (
    activeValidationRows.map((row) => (
      row.status !== 'skipped' && Number(row.baseAmount) === 0
        ? {
          ...row,
          status: 'insufficient',
          reason: 'Base amount is zero, so TDS cannot be validated for this row.',
        }
        : row
    ))
  ), [activeValidationRows])
  const ldcValidityByCertificate = useMemo(() => {
    const pairs = (uploadMeta?.ldcUtilization || [])
      .filter((row) => row.certificateNumber)
      .map((row) => [row.certificateNumber, {
        validFrom: row.validFrom,
        validTo: row.validTo,
      }])
    return new Map(pairs)
  }, [uploadMeta])
  const drawerIssue = useMemo(() => {
    const issue = reviewValidationRow || selectedIssue
    if (!issue?.ldcCertificate) return issue
    const ldcValidity = ldcValidityByCertificate.get(issue.ldcCertificate)
    return {
      ...issue,
      ldcValidFrom: issue.ldcValidFrom ?? ldcValidity?.validFrom,
      ldcValidTo: issue.ldcValidTo ?? ldcValidity?.validTo,
    }
  }, [reviewValidationRow, selectedIssue, ldcValidityByCertificate])
  const drawerIsOpen = Boolean(reviewValidationRow) || drawerOpen

  function buildValidationReviewIssue(row) {
    const isInsufficient = row.status === 'insufficient'
    const isSkipped = row.status === 'skipped'
    const inferredRate = normaliseRateForDisplay(inferRateFromAmount(row.baseAmount, row.tdsAmount))
    const statedRate = normaliseRateForDisplay(row.appliedRate)
    const expectedRate = normaliseRateForDisplay(
      row.expectedRate
      ?? (row.section === '194J' && [2, 10].includes(statedRate) ? statedRate : null)
      ?? inferredRate
      ?? DEFAULT_SECTION_RATES[row.section]
      ?? null
    )
    const appliedRate = inferredRate != null && expectedRate != null && Math.abs(inferredRate - expectedRate) <= 0.05
      ? inferredRate
      : statedRate ?? inferredRate
    const issueLabel = isSkipped ? 'Skipped' : isInsufficient ? 'Insufficient Data' : 'Passed Validation'
    const ldcValidity = ldcValidityByCertificate.get(row.ldcCertificate)

    return {
      ...row,
      ldcValidFrom: row.ldcValidFrom ?? ldcValidity?.validFrom,
      ldcValidTo: row.ldcValidTo ?? ldcValidity?.validTo,
      id: row.id || `${isSkipped ? 'SKIPPED' : isInsufficient ? 'INSUFFICIENT' : 'PASSED'}-${row.docNo}`,
      category: issueLabel,
      issueTypeLabel: issueLabel,
      issueType: isSkipped ? 'SKIPPED_ROW' : isInsufficient ? 'INSUFFICIENT_DATA' : 'PASSED_VALIDATION',
      severity: isInsufficient ? 'medium' : 'low',
      status: 'open',
      plainEnglish: row.reason || (
        isSkipped
          ? 'This row was reviewed and skipped from TDS validation.'
          : isInsufficient
          ? 'This row does not have enough usable data to complete the TDS validation.'
          : 'Validated with no issue found.'
      ),
      recommendedAction: isSkipped
        ? 'No TDS issue is raised for this row. Keep it skipped unless the source row should actually carry TDS section/rate details.'
        : isInsufficient
        ? 'Review the source row and complete the missing or unusable transaction data, then analyse the file again.'
        : 'No correction required — this row passed the current validation rules.',
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
    if (!uploadMeta) return { totalRows: issues.length, passedRows: 0, issueRows: issues.length, insufficientDataRows: 0, skippedRows: 0 }
    const skippedValidationRows = adjustedValidationRows.filter((r) => r.status === 'skipped').length
    return {
      totalRows: adjustedValidationRows.length,
      passedRows: adjustedValidationRows.filter((r) => r.status === 'passed').length,
      issueRows: adjustedValidationRows.filter((r) => r.status === 'issue').length,
      insufficientDataRows: adjustedValidationRows.filter((r) => r.status === 'insufficient').length,
      skippedRows: skippedValidationRows,
    }
  }, [issues, uploadMeta, adjustedValidationRows])

  const docTypes = useMemo(() => {
    const values = [
      ...adjustedValidationRows.map((row) => row.docType),
      ...issues.map((issue) => issue.docType),
    ]
      .map((value) => String(value || '').trim().toUpperCase())
      .filter((value) => value && value !== '—')
    return [...new Set(values)].sort()
  }, [adjustedValidationRows, issues])

  // Each KPI card's download exports exactly the rows behind that card's own
  // number (Company/FY-scoped, like the count itself) — not whatever happens
  // to be showing on the currently active tab, and not further narrowed by
  // the filter-bar's Vendor/Section/etc, which only apply to what's on
  // screen right now, not to "all Passed rows" as a concept.
  function handleExportKpi(kind) {
    const fileBase = (uploadMeta?.fileName || 'issues').replace(/\.[^.]+$/, '')
    const exportSpec = {
      all: { rows: adjustedValidationRows, columns: VALIDATION_CSV_COLUMNS, suffix: 'all-transactions' },
      passed: { rows: adjustedValidationRows.filter((r) => r.status === 'passed'), columns: VALIDATION_CSV_COLUMNS, suffix: 'passed' },
      issue: { rows: issues, columns: ISSUE_CSV_COLUMNS, suffix: 'issues-found' },
      insufficient: { rows: adjustedValidationRows.filter((r) => r.status === 'insufficient'), columns: VALIDATION_CSV_COLUMNS, suffix: 'insufficient-data' },
      skipped: { rows: adjustedValidationRows.filter((r) => r.status === 'skipped'), columns: VALIDATION_CSV_COLUMNS, suffix: 'skipped' },
    }[kind]
    if (!exportSpec || exportSpec.rows.length === 0) {
      toast('No rows to export')
      return
    }
    downloadCsv(`${fileBase}-${exportSpec.suffix}.csv`, exportSpec.columns, exportSpec.rows)
  }

  const columns = [
    { header: '#', render: (_r, i) => <span className="font-mono" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>{i + 1}</span> },
    { key: 'vendor', header: 'Vendor',    render: (r) => (
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 500 }}>{r.vendor}</div>
        <div className="font-mono" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{r.vendorId || '—'}</div>
      </div>
    )},
    { key: 'vendorPan', header: 'PAN', render: (r) => (
      <span className="font-mono" style={{ fontSize: 11.5 }}>{r.vendorPan || r.vendorId || '—'}</span>
    )},
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
    { key: 'docType', header: 'Doc Type', render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{r.docType || '—'}</span> },
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

  const transactionColumns = [
    { header: '#', render: (_r, i) => <span className="font-mono" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>{i + 1}</span> },
    { key: 'vendor', header: 'Vendor', render: (r) => (
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 500 }}>{r.vendor}</div>
        <div className="font-mono" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{r.vendorId || '—'}</div>
      </div>
    )},
    { key: 'vendorPan', header: 'PAN', render: (r) => (
      <span className="font-mono" style={{ fontSize: 11.5 }}>{r.vendorPan || r.vendorId || '—'}</span>
    )},
    { key: 'docNo', header: 'Doc No.', render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{r.docNo}</span> },
    { key: 'docType', header: 'Doc Type', render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{r.docType || '—'}</span> },
    // Temporarily hidden from the Issues UI. Keep this column definition for future restore.
    // { key: 'poNo', header: 'PO No.', render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{r.poNo || r.poNumber || '-'}</span> },
    { key: 'section', header: 'Section', render: (r) => <span className="font-mono issues-section-single">{r.section}</span> },
    { key: 'baseAmount', header: 'Base Amt', render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{formatCurrency(r.baseAmount)}</span> },
    { key: 'tdsAmount', header: 'TDS (₹)', render: (r) => <span className="font-mono" style={{ fontSize: 11.5 }}>{formatCurrency(r.tdsAmount)}</span> },
    { key: 'status', header: 'Status', sortValue: (r) => (
      r.status === 'issue' ? (r.issueTypeLabel || 'Issue Found') : formatStatusLabel(r.status)
    ), render: (r) => (
      <StatusBadge
        label={r.status === 'issue' ? (r.issueTypeLabel || 'Issue Found') : formatStatusLabel(r.status)}
        tone={r.status === 'passed' ? 'success' : r.status === 'insufficient' ? 'warning' : r.status === 'issue' ? 'danger' : 'default'}
      />
    )},
    { header: '', render: (r) => (
      r.status === 'passed' || r.status === 'insufficient' || r.status === 'skipped'
        ? (
          <button
            className="issues-review-btn"
            type="button"
            onClick={() => setReviewValidationRow(buildValidationReviewIssue(r))}
          >
            Review
          </button>
        )
        : r.status === 'issue' && r.issueId
          ? (
            <button className="issues-review-btn" type="button" onClick={() => dispatch(openDrawer(r.issueId))}>
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
    if (validationView === 'issue') {
      return filtered.map((issue, index) => ({
        ...issue,
        id: `issue-${index}-${issue.id || issue.docNo || 'row'}`,
        issueId: issue.id,
        status: 'issue',
        issueTypeLabel: getDisplayIssueType(issue),
      }))
    }

    const issueByDoc = new Map(issues.map((issue) => [String(issue.docNo ?? ''), issue]))
    return adjustedValidationRows
      .filter((row) => {
        const matchingIssue = issueByDoc.get(String(row.docNo ?? ''))
        if (monthFilter && rowMonth(row.date || matchingIssue?.date) !== monthFilter) return false
        if (validationView !== 'all' && row.status !== validationView) return false
        if (searchQuery) {
          const q = searchQuery.toLowerCase()
          if (
            !row.vendor?.toLowerCase().includes(q) &&
            !String(row.docNo ?? '').toLowerCase().includes(q) &&
            !String(row.docType ?? '').toLowerCase().includes(q) &&
            !String(row.vendorId ?? '').toLowerCase().includes(q) &&
            !String(row.section ?? '').toLowerCase().includes(q) &&
            !String(row.vendorPan ?? '').toLowerCase().includes(q)
          ) return false
        }
        if (vendorFilter  !== 'all' && row.vendor  !== vendorFilter)  return false
        if (sectionFilter !== 'all' && row.section !== sectionFilter) return false
        if (docTypeFilter !== 'all' && String(row.docType ?? '').toUpperCase() !== docTypeFilter) return false
        if (validationView === 'issue') {
          if (severityFilter !== 'all' && matchingIssue?.severity !== severityFilter) return false
          if (statusFilter !== 'all' && matchingIssue?.status !== statusFilter) return false
          if (issueTypeFilter !== 'all' && (!matchingIssue || !issueTypeFilter.split(MULTI_CATEGORY_DELIMITER).includes(getDisplayIssueType(matchingIssue)))) return false
        }
        return true
      })
      .map((row, index) => {
        const matchingIssue = issueByDoc.get(String(row.docNo ?? ''))
        return {
          ...row,
          id: `${validationView}-${index}-${row.id || row.docNo || 'row'}`,
          issueId: matchingIssue?.id,
          severity: matchingIssue?.severity,
          issueTypeLabel: matchingIssue ? getDisplayIssueType(matchingIssue) : null,
        }
      })
  }, [adjustedValidationRows, issues, filtered, validationView, searchQuery, vendorFilter, sectionFilter, docTypeFilter, severityFilter, statusFilter, issueTypeFilter, monthFilter])

  function handleResetFilters() {
    setDocTypeFilter('all')
    dispatch(resetFilters())
  }

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

      <div className="issues-summary-grid issues-summary-grid--five">
        <div className={`issues-summary-card issues-summary-card--info ${validationView === 'all' ? 'issues-summary-card--active' : ''}`}>
          <button className="issues-summary-card-clickarea" type="button" onClick={() => setValidationView('all')}>
            <Activity size={16} />
            <div>
              <div className="issues-summary-value">{summary.totalRows.toLocaleString()}</div>
              <div className="issues-summary-label">Transactions</div>
            </div>
          </button>
          {summary.totalRows > 0 && (
            <button
              className="issues-summary-card-download"
              type="button"
              title="Download CSV of all transaction rows"
              onClick={(e) => { e.stopPropagation(); handleExportKpi('all') }}
            >
              <Download size={12} />
            </button>
          )}
        </div>
        <div className={`issues-summary-card issues-summary-card--success ${validationView === 'passed' ? 'issues-summary-card--active' : ''}`}>
          <button className="issues-summary-card-clickarea" type="button" onClick={() => setValidationView('passed')}>
            <CheckCircle2 size={16} />
            <div>
              <div className="issues-summary-value">{summary.passedRows.toLocaleString()}</div>
              <div className="issues-summary-label">Passed</div>
            </div>
          </button>
          {summary.passedRows > 0 && (
            <button
              className="issues-summary-card-download"
              type="button"
              title="Download CSV of all Passed rows"
              onClick={(e) => { e.stopPropagation(); handleExportKpi('passed') }}
            >
              <Download size={12} />
            </button>
          )}
        </div>
        <div className={`issues-summary-card issues-summary-card--danger ${validationView === 'issue' ? 'issues-summary-card--active' : ''}`}>
          <button className="issues-summary-card-clickarea" type="button" onClick={() => setValidationView('issue')}>
            <AlertOctagon size={16} />
            <div>
              <div className="issues-summary-value">{summary.issueRows.toLocaleString()}</div>
              <div className="issues-summary-label">Issues Found</div>
            </div>
          </button>
          {summary.issueRows > 0 && (
            <button
              className="issues-summary-card-download"
              type="button"
              title="Download CSV of all Issues Found rows"
              onClick={(e) => { e.stopPropagation(); handleExportKpi('issue') }}
            >
              <Download size={12} />
            </button>
          )}
        </div>
        <div className={`issues-summary-card issues-summary-card--warning ${validationView === 'insufficient' ? 'issues-summary-card--active' : ''}`}>
          <button className="issues-summary-card-clickarea" type="button" onClick={() => setValidationView('insufficient')}>
            <AlertTriangle size={16} />
            <div>
              <div className="issues-summary-value">{summary.insufficientDataRows.toLocaleString()}</div>
              <div className="issues-summary-label">Insufficient Data</div>
            </div>
          </button>
          {summary.insufficientDataRows > 0 && (
            <button
              className="issues-summary-card-download"
              type="button"
              title="Download CSV of all Insufficient Data rows"
              onClick={(e) => { e.stopPropagation(); handleExportKpi('insufficient') }}
            >
              <Download size={12} />
            </button>
          )}
        </div>
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
            placeholder="Search vendor / doc / ID / section / PAN…"
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
          <select
            className="filter-select"
            value={docTypeFilter}
            onChange={(e) => setDocTypeFilter(e.target.value)}
          >
            <option value="all">All Doc Types</option>
            {docTypes.map((docType) => <option key={docType} value={docType}>{docType}</option>)}
          </select>
          <button className="filter-reset-btn" onClick={handleResetFilters}>
            <RotateCcw size={12} />Reset
          </button>
        </div>
      </div>

      <div className="table-card">
        <div className="issues-count-label">
          {`Showing ${validationTableRows.length.toLocaleString()} ${VIEW_LABELS[validationView] || 'rows'} row${validationTableRows.length === 1 ? '' : 's'}`}
          {dataSource === 'upload' ? ' from SAP upload' : ' awaiting SAP upload'}
        </div>
        <DataTable
          key={`validation-table-${validationView}`}
          columns={transactionColumns}
          data={validationTableRows}
          pageSize={50}
          emptyState={
            <div className="empty-state">
              <div className="empty-state-icon"><FileSearch size={20} /></div>
              <div className="empty-state-title">No rows match your filters</div>
              <div className="empty-state-desc">Try adjusting your search or filter criteria.</div>
              <button className="btn btn-outline btn-sm" onClick={handleResetFilters}>Reset Filters</button>
            </div>
          }
        />
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
