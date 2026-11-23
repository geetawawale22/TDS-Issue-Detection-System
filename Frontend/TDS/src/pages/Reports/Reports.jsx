import { useEffect, useMemo, useState } from 'react'
import { useSelector } from 'react-redux'
import {
  FileBarChart, FileSpreadsheet, FileText, Eye, Download, Search, Users, IdCard, LayoutList,
  SlidersHorizontal, RotateCcw, ClipboardCheck,
} from 'lucide-react'
import LiveDataBadge from '@/components/Common/LiveDataBadge'
import ReportViewModal from '@/components/Common/ReportViewModal'
import ExportPeriodDialog from '@/components/Common/ExportPeriodDialog'
import MultiSelectFilter from '@/components/Common/MultiSelectFilter'
import CategoryReportModal from './CategoryReportModal'
import IssueStatusReportModal from './IssueStatusReportModal'
import { selectFyScopedIssues, selectIsLive } from '@/redux/slices/issuesSlice'
import reportsService from '@/services/reportsService'
import { downloadCsv, downloadExcel, downloadPdf, downloadWorkbook } from '@/utils/csvExport'
import {
  buildVendorMonthlyReport, buildPanLevelReport,
  buildCategoryReport, categoryReportSheets, CATEGORY_REPORT_COLUMNS,
} from '@/utils/reportBuilders'
import {
  ISSUE_STATUS_COLUMNS, buildIssueStatusReport, issueStatusSheets, prepareIssueStatusRows,
} from '@/utils/issueStatusReport'
import { filterIncludes } from '@/utils/multiFilter'
import { formatCurrency, formatDate } from '@/utils/utils'
import { periodFileSuffix, rowsInPeriod } from '@/utils/reportPeriod'
import SearchInput from '@/components/Common/SearchInput'
import '@/components/Common/Common.css'
import './Reports.css'

const typeColors = {
  Trend:     { bg: 'var(--color-primary-50)', text: 'var(--color-primary)' },
  Vendor:    { bg: '#FEF3C7', text: '#92400E' },
  Exception: { bg: '#FEE2E2', text: 'var(--color-primary-dark)' },
  PAN:       { bg: '#EFF6FF', text: '#1E40AF' },
  Status:    { bg: '#ECFDF5', text: '#047857' },
}

// Issue-based reports, rebuilt from the issues in the export period.
const ISSUE_REPORT_BUILDERS = {
  'vendor-monthly': buildVendorMonthlyReport,
  'pan-level': buildPanLevelReport,
}

// Reports with their own viewer and a multi-sheet Excel (no PDF).
const SAVED_REPORT_KINDS = new Set(['category', 'issue-status'])

const EMPTY_FILTERS = { dateFrom: '', dateTo: '', month: '', companyCodes: 'all', vendorCode: 'all', section: 'all' }

function rowDateKey(row) {
  return String(row.postingDate || row.date || '').slice(0, 10)
}

function matchesFilters(row, filters) {
  const dateKey = rowDateKey(row)
  if (filters.dateFrom && (!dateKey || dateKey < filters.dateFrom)) return false
  if (filters.dateTo && (!dateKey || dateKey > filters.dateTo)) return false
  if (filters.month && dateKey.slice(0, 7) !== filters.month) return false
  if (!filterIncludes(filters.companyCodes, String(row.companyCode || ''))) return false
  if (filters.vendorCode !== 'all' && row.vendorId !== filters.vendorCode) return false
  if (filters.section !== 'all' && row.section !== filters.section) return false
  return true
}

// "01-04-2025 to 30-06-2025" from the rows actually in the report.
function periodOf(rows) {
  let min = ''
  let max = ''
  for (const row of rows) {
    const key = rowDateKey(row)
    if (!key) continue
    if (!min || key < min) min = key
    if (!max || key > max) max = key
  }
  if (!min) return null
  return min === max ? formatDate(min) : `${formatDate(min)} to ${formatDate(max)}`
}

// Saved-data report rows from the server (every run), all companies the user
// may see in the header's FY; the page's Company filter narrows them.
function useSavedReport(load, financialYear, trackingRunId) {
  const [state, setState] = useState({ rows: [], linesWithoutReport: 0, loading: true, error: '' })
  useEffect(() => {
    let cancelled = false
    setState((prev) => ({ ...prev, loading: true, error: '' }))
    load({ companyCode: '', financialYear })
      .then((data) => { if (!cancelled) setState({ rows: data.rows || [], linesWithoutReport: data.linesWithoutReport || 0, loading: false, error: '' }) })
      .catch((err) => { if (!cancelled) setState({ rows: [], linesWithoutReport: 0, loading: false, error: err.message || 'Could not load the saved data' }) })
    return () => { cancelled = true }
  }, [load, financialYear, trackingRunId])
  return state
}

export default function Reports() {
  const [search, setSearch] = useState('')
  const [openReportId, setOpenReportId] = useState(null)
  // { reportId, format } while the export period dialog is open.
  const [exportRequest, setExportRequest] = useState(null)
  const isLive = useSelector(selectIsLive)
  const allIssues = useSelector(selectFyScopedIssues)
  const fileName = useSelector((s) => s.issues.uploadMeta?.fileName)
  // A new analysis saves new lines and issues: reload the saved reports after it.
  const trackingRunId = useSelector((s) => s.issues.uploadMeta?.tracking?.runId ?? null)
  const selectedCompanyCode = useSelector((s) => s.app.selectedCompanyCode) || ''
  const availableCompanyCodes = useSelector((s) => s.app.availableCompanyCodes)
  const financialYear = useSelector((s) => s.app.financialYear) || ''

  // The Company filter starts from the company picked in the header and
  // follows it when the header changes; any mix of companies can be picked here.
  const headerCompanies = selectedCompanyCode ? [selectedCompanyCode] : 'all'
  const [filters, setFilters] = useState(() => ({ ...EMPTY_FILTERS, companyCodes: headerCompanies }))
  useEffect(() => {
    setFilters((prev) => ({ ...prev, companyCodes: selectedCompanyCode ? [selectedCompanyCode] : 'all' }))
  }, [selectedCompanyCode])

  const savedCategory = useSavedReport(reportsService.getCategoryRows, financialYear, trackingRunId)
  const savedIssues = useSavedReport(reportsService.getIssueStatusRows, financialYear, trackingRunId)
  const issueStatusRows = useMemo(() => prepareIssueStatusRows(savedIssues.rows), [savedIssues.rows])

  const companyOptions = useMemo(() => {
    const codes = new Set((availableCompanyCodes || []).filter(Boolean))
    for (const row of [...savedCategory.rows, ...savedIssues.rows, ...allIssues]) {
      if (row.companyCode) codes.add(String(row.companyCode))
    }
    return [...codes].sort().map((code) => [code, code])
  }, [availableCompanyCodes, savedCategory.rows, savedIssues.rows, allIssues])

  const vendorOptions = useMemo(() => {
    const byCode = new Map()
    for (const row of [...savedCategory.rows, ...savedIssues.rows, ...allIssues]) {
      if (!filterIncludes(filters.companyCodes, String(row.companyCode || ''))) continue
      if (row.vendorId && row.vendorId !== '—' && !byCode.has(row.vendorId)) byCode.set(row.vendorId, row.vendor)
    }
    return [...byCode.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [savedCategory.rows, savedIssues.rows, allIssues, filters.companyCodes])

  const sectionOptions = useMemo(() => (
    [...new Set([...savedCategory.rows, ...savedIssues.rows, ...allIssues].map((r) => r.section).filter((s) => s && s !== '—'))].sort()
  ), [savedCategory.rows, savedIssues.rows, allIssues])

  const hasFilters = Object.keys(EMPTY_FILTERS).some((key) => filters[key] !== EMPTY_FILTERS[key])
  const setFilter = (key) => (e) => setFilters((prev) => ({ ...prev, [key]: e.target.value }))

  const issues = useMemo(() => allIssues.filter((r) => matchesFilters(r, filters)), [allIssues, filters])
  const categoryRows = useMemo(() => savedCategory.rows.filter((r) => matchesFilters(r, filters)), [savedCategory.rows, filters])
  const statusRows = useMemo(() => issueStatusRows.filter((r) => matchesFilters(r, filters)), [issueStatusRows, filters])

  const categoryReport = useMemo(() => buildCategoryReport(categoryRows), [categoryRows])
  const issueStatusReport = useMemo(() => buildIssueStatusReport(statusRows), [statusRows])

  // File names say which companies and FY the report covers.
  const scopeSuffix = useMemo(() => {
    const companies = Array.isArray(filters.companyCodes) ? `-${filters.companyCodes.join('-')}` : ''
    return `${companies}${financialYear ? `-${String(financialYear).replace(/\s+/g, '')}` : ''}`
  }, [filters.companyCodes, financialYear])

  const reportDefs = useMemo(() => {
    const fileBase = (fileName || 'report').replace(/\.[^.]+$/, '')
    const dataPeriod = periodOf(issues)
    const period = !isLive
      ? 'Awaiting SAP upload'
      : dataPeriod || (fileName ? `SAP - ${fileName}` : 'Latest SAP upload')
    const savedPeriod = (saved, rows, none) => (saved.loading
      ? 'Loading saved data…'
      : `${periodOf(rows) || none} · all runs`)

    return [
      {
        id: 'category',
        kind: 'category',
        name: 'TDS Category Report',
        type: 'Exception',
        icon: LayoutList,
        description: 'Every saved transaction (all runs, selected FY) by business category - Properly Deducted, Not Applicable, Short, Excess, LDC, Not Deducted, 100% / Partial TDS on Advance - with TDS applicable vs deducted.',
        period: savedPeriod(savedCategory, categoryRows, 'No saved lines'),
        filenameBase: `tds-category-report${scopeSuffix}`,
        rows: categoryReport.tabs[0].rows,
        columns: CATEGORY_REPORT_COLUMNS,
        linesWithoutReport: savedCategory.linesWithoutReport,
        loadError: savedCategory.error,
      },
      {
        id: 'issue-status',
        kind: 'issue-status',
        name: 'Open Issues & Correction Status',
        type: 'Status',
        icon: ClipboardCheck,
        description: 'Every saved issue (all runs, each once) - open, partly corrected or resolved - with its age from the posting date, how it was resolved, the correction documents and the tax still pending. Summaries by age, category and vendor.',
        period: savedPeriod(savedIssues, statusRows, 'No saved issues'),
        filenameBase: `tds-issue-status${scopeSuffix}`,
        rows: issueStatusReport.tabs[0].rows,
        columns: ISSUE_STATUS_COLUMNS,
        loadError: savedIssues.error,
      },
      {
        id: 'vendor-monthly',
        name: 'Vendor-wise Month-on-Month',
        type: 'Vendor',
        icon: Users,
        description: 'Issue count and tax impact per vendor, broken down by month.',
        period, filenameBase: `${fileBase}-vendor-month-on-month`, ...buildVendorMonthlyReport(issues),
      },
      {
        id: 'pan-level',
        name: 'PAN-Level Report',
        type: 'PAN',
        icon: IdCard,
        description: 'Issues grouped by vendor PAN rather than vendor code - surfaces one vendor operating under multiple codes.',
        period, filenameBase: `${fileBase}-pan-level`, ...buildPanLevelReport(issues),
      },
    ]
  }, [issues, categoryRows, categoryReport, savedCategory, statusRows, issueStatusReport, savedIssues, scopeSuffix, isLive, fileName])

  const filtered = reportDefs.filter((r) =>
    r.name.toLowerCase().includes(search.toLowerCase()) ||
    r.type.toLowerCase().includes(search.toLowerCase())
  )

  const openReport = reportDefs.find((r) => r.id === openReportId) ?? null
  const exportReport = exportRequest ? reportDefs.find((r) => r.id === exportRequest.reportId) ?? null : null

  // Every export asks for a month or date range first (ExportPeriodDialog);
  // the report is then rebuilt from the source rows in that period only.
  function exportSourceRows(report) {
    if (report.kind === 'category') return categoryRows
    if (report.kind === 'issue-status') return statusRows
    return issues
  }

  function runExport(period) {
    const { format } = exportRequest
    const report = exportReport
    const source = rowsInPeriod(exportSourceRows(report), period)
    const base = `${report.filenameBase}${periodFileSuffix(period)}`
    if (report.kind === 'category') {
      const periodReport = buildCategoryReport(source)
      if (format === 'excel') downloadWorkbook(`${base}.xlsx`, categoryReportSheets(periodReport))
      else downloadCsv(`${base}.csv`, CATEGORY_REPORT_COLUMNS, periodReport.tabs[0].rows)
    } else if (report.kind === 'issue-status') {
      const periodReport = buildIssueStatusReport(source)
      if (format === 'excel') downloadWorkbook(`${base}.xlsx`, issueStatusSheets(periodReport))
      else downloadCsv(`${base}.csv`, ISSUE_STATUS_COLUMNS, periodReport.tabs[0].rows)
    } else {
      const { columns, rows } = ISSUE_REPORT_BUILDERS[report.id](source)
      if (format === 'csv') downloadCsv(`${base}.csv`, columns, rows)
      else if (format === 'excel') downloadExcel(`${base}.xlsx`, columns, rows)
      else downloadPdf(`${base}.pdf`, report.name, columns, rows)
    }
    setExportRequest(null)
  }

  const scopeText = `${Array.isArray(filters.companyCodes) ? `Company ${filters.companyCodes.join(', ')}` : 'All companies'}${financialYear ? ` · ${financialYear}` : ''}`

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="breadcrumb">
            <span>Home</span><span className="breadcrumb-sep">&gt;</span>
            <span className="breadcrumb-current">Reports</span>
          </div>
          <h1 className="page-title">Reports</h1>
        </div>
        <div className="issues-header-actions">
          <LiveDataBadge />
          <div className="reports-search-wrapper">
            <Search size={14} className="reports-search-icon" />
            <SearchInput
              className="reports-search"
              placeholder="Search reports..."
              value={search}
              onChange={setSearch}
            />
          </div>
        </div>
      </div>

      <div className="filter-bar reports-filter-bar">
        <div className="filter-bar-top">
          <div className="filter-bar-label">
            <SlidersHorizontal size={14} />Report Filters
          </div>
          {hasFilters && <span className="reports-filter-state">Applied to every report</span>}
        </div>
        <div className="filter-bar-controls reports-filter-controls">
          <div className="reports-filter-control">
            <span>Company Code</span>
            <MultiSelectFilter
              allLabel="All Company Codes"
              options={companyOptions}
              value={filters.companyCodes}
              onChange={(next) => setFilters((prev) => ({ ...prev, companyCodes: next }))}
            />
          </div>
          <label className="reports-filter-control">
            <span>From Date</span>
            <input className="filter-input" type="date" value={filters.dateFrom} onChange={setFilter('dateFrom')} />
          </label>
          <label className="reports-filter-control">
            <span>To Date</span>
            <input className="filter-input" type="date" value={filters.dateTo} onChange={setFilter('dateTo')} />
          </label>
          <label className="reports-filter-control">
            <span>Month</span>
            <input className="filter-input" type="month" value={filters.month} onChange={setFilter('month')} />
          </label>
          <label className="reports-filter-control">
            <span>Vendor Code</span>
            <select className="filter-select" value={filters.vendorCode} onChange={setFilter('vendorCode')}>
              <option value="all">All Vendor Codes</option>
              {vendorOptions.map(([code, name]) => (
                <option key={code} value={code}>{name && name !== code ? `${code} (${name})` : code}</option>
              ))}
            </select>
          </label>
          <label className="reports-filter-control">
            <span>Section</span>
            <select className="filter-select" value={filters.section} onChange={setFilter('section')}>
              <option value="all">All Sections</option>
              {sectionOptions.map((section) => <option key={section} value={section}>{section}</option>)}
            </select>
          </label>
          <button
            className="filter-reset-btn reports-filter-reset"
            type="button"
            disabled={!hasFilters}
            onClick={() => setFilters(EMPTY_FILTERS)}
          >
            <RotateCcw size={12} />Reset
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon"><FileBarChart size={20} /></div>
          <div className="empty-state-title">No reports found</div>
          <div className="empty-state-desc">Try a different search term.</div>
        </div>
      ) : (
        <div className="reports-grid">
          {filtered.map((report) => {
            const Icon = report.icon ?? FileBarChart
            const tc = typeColors[report.type] ?? typeColors.Trend
            const isCategory = report.kind === 'category'
            const isIssueStatus = report.kind === 'issue-status'
            const isSaved = SAVED_REPORT_KINDS.has(report.kind)
            const noRows = report.rows.length === 0
            return (
              <div key={report.id} className={`report-card ${isCategory ? 'report-card--featured' : ''}`}>
                <div className="report-card-header">
                  <div className="report-icon-box" style={{ background: tc.bg }}>
                    <Icon size={18} style={{ color: tc.text }} />
                  </div>
                  <div className="report-type-tag" style={{ background: tc.bg, color: tc.text }}>
                    {isCategory ? 'Category-wise' : report.type}
                  </div>
                </div>
                <h3 className="report-name">{report.name}</h3>
                <p className="report-desc">{report.description}</p>
                {isSaved && report.loadError && <p className="report-notice">{report.loadError}</p>}
                {isCategory && report.linesWithoutReport > 0 && (
                  <p className="report-notice">
                    {report.linesWithoutReport.toLocaleString()} saved SAP line{report.linesWithoutReport === 1 ? ' was' : 's were'} analysed before this report used saved data and {report.linesWithoutReport === 1 ? 'is' : 'are'} not included. Analyse {report.linesWithoutReport === 1 ? 'its' : 'their'} file again on TDS Analysis to add {report.linesWithoutReport === 1 ? 'it' : 'them'}.
                  </p>
                )}
                {isCategory && categoryReport.tabs[0].rows.length > 0 && (
                  <div className="report-category-chips">
                    {categoryReport.tabs.slice(1).filter((t) => t.rows.length > 0).map((t) => (
                      <span key={t.id} className="report-category-chip">
                        {t.label} <strong>{t.rows.length.toLocaleString()}</strong>
                      </span>
                    ))}
                  </div>
                )}
                {isIssueStatus && issueStatusReport.tabs[0].rows.length > 0 && (
                  <div className="report-category-chips">
                    {issueStatusReport.tabs.slice(1).map((t) => (
                      <span key={t.id} className="report-category-chip">
                        {t.label} <strong>{t.rows.length.toLocaleString()}</strong>
                      </span>
                    ))}
                    <span className="report-category-chip">
                      Pending tax <strong>{formatCurrency(issueStatusReport.totals.pendingImpact)}</strong>
                    </span>
                  </div>
                )}
                <div className="report-meta">
                  <span>{report.period}</span>
                  <span className="font-mono">{report.rows.length.toLocaleString()} rows</span>
                </div>
                <div className="report-actions">
                  <button
                    className="btn btn-outline btn-sm report-action-btn"
                    type="button"
                    disabled={isSaved && noRows}
                    onClick={() => setOpenReportId(report.id)}
                  >
                    <Eye size={12} />View
                  </button>
                  <button
                    className="btn btn-outline btn-sm report-action-btn"
                    type="button"
                    disabled={noRows}
                    onClick={() => setExportRequest({ reportId: report.id, format: 'csv' })}
                  >
                    <Download size={12} />CSV
                  </button>
                  <button
                    className="btn btn-outline btn-sm report-action-btn"
                    type="button"
                    disabled={noRows}
                    onClick={() => setExportRequest({ reportId: report.id, format: 'excel' })}
                    title={isCategory ? 'Summary, All and one sheet per category' : isIssueStatus ? 'Summaries by age, category and vendor, then one sheet per status' : undefined}
                  >
                    <FileSpreadsheet size={12} />Excel
                  </button>
                  {!isSaved && (
                    <button
                      className="btn btn-outline btn-sm report-action-btn"
                      type="button"
                      disabled={noRows}
                      onClick={() => setExportRequest({ reportId: report.id, format: 'pdf' })}
                    >
                      <FileText size={12} />PDF
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {openReport?.kind === 'category' && (
        <CategoryReportModal
          title={openReport.name}
          description={`${openReport.period} · ${scopeText}${hasFilters ? ' · report filters applied' : ''}`}
          report={categoryReport}
          filenameBase={openReport.filenameBase}
          onClose={() => setOpenReportId(null)}
        />
      )}
      {openReport?.kind === 'issue-status' && (
        <IssueStatusReportModal
          title={openReport.name}
          description={`${openReport.period} · ${scopeText}${hasFilters ? ' · report filters applied' : ''} · age counted from the posting date`}
          report={issueStatusReport}
          filenameBase={openReport.filenameBase}
          onClose={() => setOpenReportId(null)}
        />
      )}
      {openReport && !SAVED_REPORT_KINDS.has(openReport.kind) && (
        <ReportViewModal
          title={openReport.name}
          description={openReport.description}
          columns={openReport.columns}
          rows={openReport.rows}
          filenameBase={openReport.filenameBase}
          onClose={() => setOpenReportId(null)}
          onExport={(format) => setExportRequest({ reportId: openReport.id, format })}
        />
      )}
      {exportReport && (
        <ExportPeriodDialog
          format={exportRequest.format}
          reportName={exportReport.name}
          note={exportReport.kind === 'category' && exportRequest.format === 'excel'
            ? 'Summary, All and one sheet per category'
            : exportReport.kind === 'issue-status' && exportRequest.format === 'excel'
              ? 'Summaries by age, category and vendor, then one sheet per status'
              : undefined}
          rows={exportSourceRows(exportReport)}
          recordLabel={exportReport.kind === 'category' ? 'transactions' : 'issues'}
          onCancel={() => setExportRequest(null)}
          onExport={runExport}
        />
      )}
    </div>
  )
}
