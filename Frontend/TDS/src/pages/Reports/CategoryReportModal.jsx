import { useMemo, useState } from 'react'
import { X, Download, FileSpreadsheet } from 'lucide-react'
import DataTable from '@/components/Common/DataTable'
import SearchInput from '@/components/Common/SearchInput'
import ExportPeriodDialog from '@/components/Common/ExportPeriodDialog'
import StatusBadge from '@/components/Common/StatusBadge'
import { downloadCsv, downloadWorkbook } from '@/utils/csvExport'
import { formatCurrency } from '@/utils/utils'
import {
  CATEGORY_REPORT_COLUMNS, buildCategoryReport, categoryReportSheets, countsInTotals, deductedAmount, rowStatusLabel,
} from '@/utils/reportBuilders'
import { DATE_BASES, periodFileSuffix, rowsInPeriod } from '@/utils/reportPeriod'

const STATUS_TONES = { passed: 'success', issue: 'danger', corrected: 'success', insufficient: 'warning', skipped: 'neutral' }

const STATUS_FILTERS = [
  { id: 'all', label: 'All Statuses' },
  { id: 'issue', label: 'Open Issues' },
  { id: 'corrected', label: 'Resolved' },
  { id: 'passed', label: 'Correct' },
  { id: 'review', label: 'Insufficient / Not Validated' },
]

function matchesStatus(row, filter) {
  if (filter === 'all') return true
  if (filter === 'review') return row.status === 'insufficient' || row.status === 'skipped'
  return row.status === filter
}

const PAGE_SIZE = 200

function withSerial(rows) {
  return rows.map((row, i) => ({ ...row, serial: i + 1 }))
}

function numericSort(col) {
  return (r) => {
    const v = col.excelValue ? col.excelValue(r) : col.value(r)
    return v == null || v === '' ? null : Number(v)
  }
}

// On-screen columns = the business workbook's columns (CATEGORY_REPORT_COLUMNS),
// so the table, CSV and Excel all match.
const TABLE_COLUMNS = CATEGORY_REPORT_COLUMNS.map((col) => ({
  key: col.id,
  header: col.label,
  group: col.group,
  headerClassName: col.numeric ? 'report-col-num' : undefined,
  cellClassName: col.numeric ? 'report-col-num' : col.wide ? 'report-col-wide' : 'report-col',
  sortValue: col.sortValue ?? (col.numeric ? numericSort(col) : (r) => col.value(r)),
  render: col.id === 'status'
    ? (r) => <StatusBadge label={rowStatusLabel(r)} tone={STATUS_TONES[r.status] ?? 'neutral'} />
    : col.id === 'remark'
      ? (r) => <div className="report-remark" title={r.remark || ''}>{r.remark || '—'}</div>
      : (r) => {
          const v = col.value(r)
          return v == null || v === '' ? <span className="report-muted">—</span> : v
        },
}))

/**
 * TDS Category Report viewer: All + one tab per business category, matching
 * the scenario workbook. The date range applies to the tabs, the table and
 * both downloads: Excel has every tab as its own sheet, CSV has the tab (and
 * search / status filter) on screen.
 */
export default function CategoryReportModal({ title, description, report, filenameBase, onClose }) {
  const [activeTab, setActiveTab] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [dateField, setDateField] = useState('postingDate')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  const hasDateRange = Boolean(dateFrom || dateTo)
  // Re-built for the date range so tab counts, serial numbers and the
  // Summary sheet all cover only the chosen period.
  const viewReport = useMemo(
    () => (hasDateRange
      ? buildCategoryReport(rowsInPeriod(report.tabs[0].rows, { mode: 'range', basis: dateField, from: dateFrom, to: dateTo }))
      : report),
    [report, hasDateRange, dateField, dateFrom, dateTo],
  )

  const tab = viewReport.tabs.find((t) => t.id === activeTab) ?? viewReport.tabs[0]

  const [exportFormat, setExportFormat] = useState(null) // 'csv' | 'excel' while the period dialog is open

  const matchesSearchAndStatus = useMemo(() => {
    const term = search.trim().toLowerCase()
    return (row) => {
      if (!matchesStatus(row, statusFilter)) return false
      if (!term) return true
      return [row.docNo, row.vendor, row.vendorId, row.vendorPan, row.billNo, row.glAccount, row.glDescription, row.txnDescription, row.remark]
        .some((v) => String(v ?? '').toLowerCase().includes(term))
    }
  }, [statusFilter, search])

  const rows = useMemo(() => tab.rows.filter(matchesSearchAndStatus), [tab, matchesSearchAndStatus])

  // Totals for what is on screen (tab + filters), not the whole tab.
  const totals = useMemo(() => rows.reduce((acc, row) => {
    if (row.status === 'issue') acc.issues += 1
    if (row.applicableAmount != null && countsInTotals(row)) acc.difference += Number(row.applicableAmount) - deductedAmount(row)
    return acc
  }, { issues: 0, difference: 0 }), [rows])

  const fileTab = tab.id === 'all' ? 'all' : tab.sheet.toLowerCase().replace(/[^a-z0-9]+/g, '-')

  // The export dialog chooses the period itself (pre-filled with the range
  // set above), so exports start from the whole report, not the view.
  // CSV: this tab with its search / status filter. Excel: every tab.
  const exportSourceRows = exportFormat === 'csv'
    ? (report.tabs.find((t) => t.id === tab.id) ?? report.tabs[0]).rows.filter(matchesSearchAndStatus)
    : report.tabs[0].rows
  const exportInitialPeriod = hasDateRange ? { mode: 'range', basis: dateField, from: dateFrom, to: dateTo } : undefined

  function runExport(period) {
    const suffix = periodFileSuffix(period)
    if (exportFormat === 'csv') {
      downloadCsv(`${filenameBase}-${fileTab}${suffix}.csv`, CATEGORY_REPORT_COLUMNS, withSerial(rowsInPeriod(exportSourceRows, period)))
    } else {
      const periodReport = buildCategoryReport(rowsInPeriod(report.tabs[0].rows, period))
      downloadWorkbook(`${filenameBase}${suffix}.xlsx`, categoryReportSheets(periodReport))
    }
    setExportFormat(null)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="report-modal-card report-modal-card--wide" onClick={(e) => e.stopPropagation()}>
        <div className="report-modal-header">
          <div style={{ minWidth: 0 }}>
            <h3 className="settings-card-title">{title}</h3>
            {description && <p className="report-modal-desc">{description}</p>}
          </div>
          <button className="issue-drawer-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="report-tabs" role="tablist" aria-label="Report categories">
          {viewReport.tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={t.id === tab.id}
              className={`report-tab ${t.id === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
              <span className="report-tab-count">{t.rows.length.toLocaleString()}</span>
            </button>
          ))}
        </div>

        <div className="report-modal-toolbar">
          <div className="report-modal-filters">
            <SearchInput
              className="report-modal-search"
              placeholder="Search doc, vendor, PAN, bill, GL, remark..."
              value={search}
              onChange={setSearch}
            />
            <select className="filter-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              {STATUS_FILTERS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
            <div className="report-modal-dates" role="group" aria-label="Date range">
              <select className="filter-select" value={dateField} onChange={(e) => setDateField(e.target.value)} aria-label="Date to filter on">
                {DATE_BASES.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
              <input
                className="filter-input"
                type="date"
                value={dateFrom}
                max={dateTo || undefined}
                onChange={(e) => setDateFrom(e.target.value)}
                aria-label="From date"
              />
              <span className="report-muted">to</span>
              <input
                className="filter-input"
                type="date"
                value={dateTo}
                min={dateFrom || undefined}
                onChange={(e) => setDateTo(e.target.value)}
                aria-label="To date"
              />
              {hasDateRange && (
                <button className="btn btn-outline btn-sm" type="button" onClick={() => { setDateFrom(''); setDateTo('') }}>
                  Clear
                </button>
              )}
            </div>
            <span className="report-modal-count">
              {rows.length.toLocaleString()} row{rows.length === 1 ? '' : 's'}
              {' · '}Open issues {totals.issues.toLocaleString()}
              {' · '}Short (+) / Excess (−) {formatCurrency(totals.difference)}
            </span>
          </div>
          <div className="report-modal-export-actions">
            <button
              className="btn btn-outline btn-sm"
              type="button"
              disabled={report.tabs[0].rows.length === 0}
              onClick={() => setExportFormat('csv')}
              title="Download this tab (with the search and status filter) for a month or date range"
            >
              <Download size={12} />CSV (this tab)
            </button>
            <button
              className="btn btn-outline btn-sm"
              type="button"
              disabled={report.tabs[0].rows.length === 0}
              onClick={() => setExportFormat('excel')}
              title="Summary, All and one sheet per category, for a month or date range"
            >
              <FileSpreadsheet size={12} />Excel (all tabs)
            </button>
          </div>
        </div>

        <div className="report-modal-table">
          <DataTable
            columns={TABLE_COLUMNS}
            data={rows}
            pageSize={PAGE_SIZE}
            emptyState={
              <div className="empty-state">
                <div className="empty-state-title">No transactions in this category</div>
                <div className="empty-state-desc">Nothing in the current filters falls under {tab.label}.</div>
              </div>
            }
          />
        </div>
      </div>

      {exportFormat && (
        <ExportPeriodDialog
          format={exportFormat}
          reportName={title}
          note={exportFormat === 'csv'
            ? `${tab.label} tab${search.trim() || statusFilter !== 'all' ? ', search / status filter applied' : ''}`
            : 'Summary, All and one sheet per category'}
          rows={exportSourceRows}
          recordLabel="transactions"
          initialPeriod={exportInitialPeriod}
          onCancel={() => setExportFormat(null)}
          onExport={runExport}
        />
      )}
    </div>
  )
}
