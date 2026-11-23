import { useMemo, useState } from 'react'
import { X, Download, FileSpreadsheet } from 'lucide-react'
import DataTable from '@/components/Common/DataTable'
import SearchInput from '@/components/Common/SearchInput'
import ExportPeriodDialog from '@/components/Common/ExportPeriodDialog'
import StatusBadge from '@/components/Common/StatusBadge'
import { downloadCsv, downloadWorkbook } from '@/utils/csvExport'
import { formatCurrency } from '@/utils/utils'
import { periodFileSuffix, rowsInPeriod } from '@/utils/reportPeriod'
import {
  AGE_BUCKETS, ISSUE_STATUS_COLUMNS, buildIssueStatusReport, issueStatusSheets,
} from '@/utils/issueStatusReport'

const STATUS_TONES = { open: 'danger', partial: 'warning', resolved: 'success' }
const PAGE_SIZE = 200

function numericSort(col) {
  return (r) => {
    const v = col.excelValue ? col.excelValue(r) : col.value(r)
    return v == null || v === '' ? null : Number(v)
  }
}

const TABLE_COLUMNS = ISSUE_STATUS_COLUMNS.map((col) => ({
  key: col.id,
  header: col.label,
  headerClassName: col.numeric ? 'report-col-num' : undefined,
  cellClassName: col.numeric ? 'report-col-num' : col.wide ? 'report-col-wide' : 'report-col',
  sortValue: col.sortValue ?? (col.numeric ? numericSort(col) : (r) => col.value(r)),
  render: col.id === 'status'
    ? (r) => <StatusBadge label={col.value(r)} tone={STATUS_TONES[r.statusGroup] ?? 'neutral'} />
    : col.id === 'remark'
      ? (r) => <div className="report-remark" title={col.value(r)}>{col.value(r) || '—'}</div>
      : (r) => {
          const v = col.value(r)
          return v == null || v === '' ? <span className="report-muted">—</span> : v
        },
}))

/**
 * Open Issues & Correction Status viewer: All / Open / Partly Corrected /
 * Resolved tabs, an age strip (click a bucket to show only those issues),
 * CSV of the tab on screen and an Excel workbook with the summaries.
 */
export default function IssueStatusReportModal({ title, description, report, filenameBase, onClose }) {
  const [activeTab, setActiveTab] = useState('all')
  const [ageFilter, setAgeFilter] = useState(null)
  const [search, setSearch] = useState('')
  const [exportFormat, setExportFormat] = useState(null)

  const tab = report.tabs.find((t) => t.id === activeTab) ?? report.tabs[0]

  const matchesView = useMemo(() => {
    const term = search.trim().toLowerCase()
    return (row) => {
      if (ageFilter && row.ageBucket !== ageFilter) return false
      if (!term) return true
      return [row.docNo, row.vendor, row.vendorId, row.vendorPan, row.category, row.section, row.resolutionNote, ...(row.correctionDocs || []).map((d) => d?.docNo)]
        .some((v) => String(v ?? '').toLowerCase().includes(term))
    }
  }, [ageFilter, search])

  const rows = useMemo(() => tab.rows.filter(matchesView), [tab, matchesView])
  const pendingImpact = useMemo(() => rows.reduce((sum, row) => (
    row.statusGroup === 'resolved' ? sum
      : sum + Math.abs(Number(row.statusGroup === 'partial' && row.remainingShortfall != null ? row.remainingShortfall : row.taxImpact) || 0)
  ), 0), [rows])

  // Pending issues (open + partly corrected) per age bucket, for the strip.
  const pendingByAge = useMemo(() => {
    const counts = new Map(AGE_BUCKETS.map((b) => [b.id, 0]))
    for (const row of report.tabs[0].rows) {
      if (row.statusGroup !== 'resolved' && counts.has(row.ageBucket)) counts.set(row.ageBucket, counts.get(row.ageBucket) + 1)
    }
    return counts
  }, [report])

  const exportSourceRows = exportFormat === 'csv' ? tab.rows.filter(matchesView) : report.tabs[0].rows

  function runExport(period) {
    const suffix = periodFileSuffix(period)
    if (exportFormat === 'csv') {
      const fileTab = tab.id === 'all' ? 'all' : tab.sheet.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      const periodRows = rowsInPeriod(exportSourceRows, period).map((row, i) => ({ ...row, serial: i + 1 }))
      downloadCsv(`${filenameBase}-${fileTab}${suffix}.csv`, ISSUE_STATUS_COLUMNS, periodRows)
    } else {
      downloadWorkbook(`${filenameBase}${suffix}.xlsx`, issueStatusSheets(buildIssueStatusReport(rowsInPeriod(report.tabs[0].rows, period))))
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

        <div className="report-tabs" role="tablist" aria-label="Issue status">
          {report.tabs.map((t) => (
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

        <div className="report-age-strip" role="group" aria-label="Pending issues by age (from posting date)">
          <span className="report-age-strip-label">Pending by age</span>
          {AGE_BUCKETS.map((bucket) => (
            <button
              key={bucket.id}
              type="button"
              className={`report-category-chip report-age-chip ${ageFilter === bucket.id ? 'active' : ''}`}
              onClick={() => setAgeFilter((current) => (current === bucket.id ? null : bucket.id))}
              title={ageFilter === bucket.id ? 'Click again to show every age' : 'Show only issues of this age'}
            >
              {bucket.label} <strong>{(pendingByAge.get(bucket.id) || 0).toLocaleString()}</strong>
            </button>
          ))}
        </div>

        <div className="report-modal-toolbar">
          <div className="report-modal-filters">
            <SearchInput
              className="report-modal-search"
              placeholder="Search doc, vendor, PAN, issue, correction doc..."
              value={search}
              onChange={setSearch}
            />
            <span className="report-modal-count">
              {rows.length.toLocaleString()} issue{rows.length === 1 ? '' : 's'}
              {' · '}Pending tax impact {formatCurrency(pendingImpact)}
            </span>
          </div>
          <div className="report-modal-export-actions">
            <button
              className="btn btn-outline btn-sm"
              type="button"
              disabled={report.tabs[0].rows.length === 0}
              onClick={() => setExportFormat('csv')}
              title="Download this tab (with the search and age filter) for a month or date range"
            >
              <Download size={12} />CSV (this tab)
            </button>
            <button
              className="btn btn-outline btn-sm"
              type="button"
              disabled={report.tabs[0].rows.length === 0}
              onClick={() => setExportFormat('excel')}
              title="Summaries by age, category and vendor, then one sheet per status"
            >
              <FileSpreadsheet size={12} />Excel (all sheets)
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
                <div className="empty-state-title">No issues here</div>
                <div className="empty-state-desc">Nothing in the current filters is {tab.label.toLowerCase()}.</div>
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
            ? `${tab.label} tab${search.trim() || ageFilter ? ', search / age filter applied' : ''}`
            : 'Summaries by age, category and vendor, then one sheet per status'}
          rows={exportSourceRows}
          recordLabel="issues"
          onCancel={() => setExportFormat(null)}
          onExport={runExport}
        />
      )}
    </div>
  )
}
