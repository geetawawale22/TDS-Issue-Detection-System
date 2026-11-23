/**
 * Open Issues & Correction Status report: every saved issue (all runs, each
 * once) from the issue history (GET /reports/issue-status), with how long it
 * has been open and how it was resolved.
 *
 * Age counts from the posting date (when the TDS should have been right): to
 * today for an open issue, to the resolution date for a resolved one.
 */
import { formatCurrency, formatDate } from '@/utils/utils'
import { reportCategoryLabel } from '@/utils/reportBuilders'

export const ISSUE_STATUS_TABS = [
  { id: 'all', label: 'All', sheet: 'All Issues' },
  { id: 'open', label: 'Open', sheet: 'Open' },
  { id: 'partial', label: 'Partly Corrected', sheet: 'Partly Corrected' },
  { id: 'resolved', label: 'Resolved', sheet: 'Resolved' },
]

export const AGE_BUCKETS = [
  { id: '0-30', label: '0–30 days', max: 30 },
  { id: '31-60', label: '31–60 days', max: 60 },
  { id: '61-90', label: '61–90 days', max: 90 },
  { id: '91-180', label: '91–180 days', max: 180 },
  { id: '180+', label: 'Over 180 days', max: Infinity },
]

const RESOLUTION_LABELS = {
  REVERSED: 'Document reversed',
  CORRECTION_POSTED: 'Correction entry posted',
  NO_LONGER_FLAGGED: 'No longer raised',
  MANUAL: 'Resolved by hand',
}

const DAY_MS = 24 * 60 * 60 * 1000

function dayStart(value) {
  const key = String(value || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null
  const [y, m, d] = key.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

/** 'open' | 'partial' | 'resolved' */
export function issueStatusGroup(row) {
  if (row.status === 'resolved') return 'resolved'
  return (row.correctionDocs && row.correctionDocs.length) || row.remainingShortfall != null ? 'partial' : 'open'
}

const STATUS_LABELS = { open: 'Open', partial: 'Partly Corrected', resolved: 'Resolved' }

/** Days from posting date to today (open) or to the resolution date (resolved). */
export function issueAgeDays(row, today = new Date()) {
  const start = dayStart(row.postingDate)
  if (start == null) return null
  const end = row.status === 'resolved' && row.resolvedAt
    ? dayStart(row.resolvedAt)
    : Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.max(0, Math.round((end - start) / DAY_MS))
}

export function ageBucket(days) {
  if (days == null) return null
  return AGE_BUCKETS.find((bucket) => days <= bucket.max)?.id ?? null
}

function amount(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
}

function magnitude(v) {
  const n = amount(v)
  return n == null ? null : Math.abs(n)
}

function money(v) {
  return v == null ? '' : formatCurrency(v)
}

function correctionDocList(row) {
  return (row.correctionDocs || []).map((doc) => doc?.docNo).filter(Boolean).join(', ')
}

/** Rows with the derived fields every view and sheet uses. */
export function prepareIssueStatusRows(rows, today = new Date()) {
  return rows.map((row) => {
    const ageDays = issueAgeDays(row, today)
    return {
      ...row,
      statusGroup: issueStatusGroup(row),
      ageDays,
      ageBucket: ageBucket(ageDays),
    }
  })
}

export const ISSUE_STATUS_COLUMNS = [
  { id: 'serial', label: 'S.No.', value: (r) => r.serial, numeric: true },
  { id: 'status', label: 'Status', value: (r) => STATUS_LABELS[r.statusGroup] },
  { id: 'companyCode', label: 'Company Code', value: (r) => r.companyCode || '' },
  { id: 'vendorCode', label: 'Vendor Code', value: (r) => r.vendorId || '' },
  { id: 'vendorName', label: 'Vendor Name', value: (r) => r.vendor || '', wide: true },
  { id: 'pan', label: 'PAN', value: (r) => r.vendorPan || '' },
  { id: 'docNo', label: 'Document No.', value: (r) => r.docNo || '' },
  { id: 'lineItem', label: 'Line Item', value: (r) => r.lineItem || '' },
  { id: 'docType', label: 'Document Type', value: (r) => r.docType || '' },
  { id: 'postingDate', label: 'Posting Date', value: (r) => (r.postingDate ? formatDate(r.postingDate) : ''), sortValue: (r) => r.postingDate || '' },
  { id: 'section', label: 'Section', value: (r) => r.section || '' },
  { id: 'reportCategory', label: 'Issue Category', value: (r) => (r.reportCategory ? reportCategoryLabel(r.reportCategory) : '') },
  { id: 'issue', label: 'Issue', value: (r) => r.category || '', wide: true },
  { id: 'severity', label: 'Severity', value: (r) => (r.severity ? r.severity[0].toUpperCase() + r.severity.slice(1) : '') },
  { id: 'baseAmount', label: 'Base Amount', value: (r) => money(magnitude(r.baseAmount)), excelValue: (r) => magnitude(r.baseAmount), numeric: true },
  { id: 'tdsAmount', label: 'TDS Deducted', value: (r) => money(magnitude(r.tdsAmount)), excelValue: (r) => magnitude(r.tdsAmount), numeric: true },
  { id: 'expectedRate', label: 'Expected Rate (%)', value: (r) => (r.expectedRate == null ? '' : `${Number(r.expectedRate)}%`), excelValue: (r) => amount(r.expectedRate), numeric: true },
  { id: 'taxImpact', label: 'Tax Impact', value: (r) => money(amount(r.taxImpact)), excelValue: (r) => amount(r.taxImpact), numeric: true },
  { id: 'remainingShortfall', label: 'Remaining Shortfall', value: (r) => money(amount(r.remainingShortfall)), excelValue: (r) => amount(r.remainingShortfall), numeric: true },
  { id: 'ageDays', label: 'Age (days)', value: (r) => (r.ageDays == null ? '' : r.ageDays), numeric: true },
  { id: 'ageBucket', label: 'Age Bucket', value: (r) => AGE_BUCKETS.find((b) => b.id === r.ageBucket)?.label || '' },
  { id: 'firstSeen', label: 'First Found', value: (r) => (r.firstSeenAt ? formatDate(r.firstSeenAt) : ''), sortValue: (r) => r.firstSeenAt || '' },
  { id: 'resolution', label: 'Resolution', value: (r) => RESOLUTION_LABELS[r.resolutionType] || '' },
  { id: 'correctionDocs', label: 'Correction Docs', value: (r) => correctionDocList(r) },
  { id: 'correctedTds', label: 'Corrected TDS', value: (r) => money(amount(r.correctedTds)), excelValue: (r) => amount(r.correctedTds), numeric: true },
  { id: 'resolvedOn', label: 'Resolved On', value: (r) => (r.resolvedAt ? formatDate(r.resolvedAt) : ''), sortValue: (r) => r.resolvedAt || '' },
  { id: 'remark', label: 'Remark', value: (r) => r.resolutionNote || r.description || '', wide: true },
]

function withSerial(rows) {
  return rows.map((row, i) => ({ ...row, serial: i + 1 }))
}

function addTo(totals, row) {
  const impact = Math.abs(Number(row.taxImpact) || 0)
  totals.count += 1
  totals.taxImpact += impact
  totals[row.statusGroup] += 1
  if (row.statusGroup !== 'resolved') {
    totals.pendingImpact += row.statusGroup === 'partial' && row.remainingShortfall != null
      ? Math.abs(Number(row.remainingShortfall) || 0)
      : impact
    if (row.ageDays != null) totals.oldestOpen = Math.max(totals.oldestOpen ?? 0, row.ageDays)
  }
  return totals
}

function emptyTotals(extra = {}) {
  return { ...extra, count: 0, open: 0, partial: 0, resolved: 0, taxImpact: 0, pendingImpact: 0, oldestOpen: null }
}

/**
 * { tabs: [{ id, label, sheet, rows }], ageRows, vendorRows, categoryRows, totals }
 * `rows` from prepareIssueStatusRows.
 */
export function buildIssueStatusReport(rows) {
  const ordered = [...rows].sort((a, b) => (
    String(a.postingDate || '').localeCompare(String(b.postingDate || ''))
    || String(a.docNo || '').localeCompare(String(b.docNo || ''))
  ))
  const tabs = ISSUE_STATUS_TABS.map((tab) => ({
    ...tab,
    rows: withSerial(tab.id === 'all' ? ordered : ordered.filter((row) => row.statusGroup === tab.id)),
  }))

  // Status × age: pending (open + partly corrected) by how long they have been open.
  const ageRows = AGE_BUCKETS.map((bucket) => emptyTotals({ label: bucket.label, id: bucket.id }))
  const byVendor = new Map()
  const byCategory = new Map()
  const totals = emptyTotals({ label: 'Total' })
  for (const row of ordered) {
    addTo(totals, row)
    const bucket = ageRows.find((b) => b.id === row.ageBucket)
    if (bucket) addTo(bucket, row)
    const vendorKey = row.vendorId || row.vendor || '—'
    if (!byVendor.has(vendorKey)) byVendor.set(vendorKey, emptyTotals({ vendorCode: row.vendorId || '', vendor: row.vendor || '', pan: row.vendorPan || '' }))
    addTo(byVendor.get(vendorKey), row)
    const categoryKey = row.reportCategory ? reportCategoryLabel(row.reportCategory) : 'Other / Needs Review'
    if (!byCategory.has(categoryKey)) byCategory.set(categoryKey, emptyTotals({ label: categoryKey }))
    addTo(byCategory.get(categoryKey), row)
  }
  const vendorRows = [...byVendor.values()].sort((a, b) => (b.open + b.partial) - (a.open + a.partial) || b.pendingImpact - a.pendingImpact)
  const categoryRows = [...byCategory.values()].sort((a, b) => b.count - a.count)
  return { tabs, ageRows: [...ageRows, totals], vendorRows, categoryRows: [...categoryRows, totals], totals }
}

const COUNT_COLUMNS = [
  { label: 'Total Issues', value: (r) => r.count },
  { label: 'Open', value: (r) => r.open },
  { label: 'Partly Corrected', value: (r) => r.partial },
  { label: 'Resolved', value: (r) => r.resolved },
  { label: 'Tax Impact (all)', value: (r) => formatCurrency(r.taxImpact), excelValue: (r) => amount(r.taxImpact) },
  { label: 'Pending Tax Impact', value: (r) => formatCurrency(r.pendingImpact), excelValue: (r) => amount(r.pendingImpact) },
]

export const AGE_SUMMARY_COLUMNS = [
  { label: 'Age (from posting date)', value: (r) => r.label },
  ...COUNT_COLUMNS,
]

export const CATEGORY_SUMMARY_COLUMNS = [
  { label: 'Issue Category', value: (r) => r.label },
  ...COUNT_COLUMNS,
]

export const VENDOR_SUMMARY_COLUMNS = [
  { label: 'Vendor Code', value: (r) => r.vendorCode },
  { label: 'Vendor Name', value: (r) => r.vendor },
  { label: 'PAN', value: (r) => r.pan },
  ...COUNT_COLUMNS,
  { label: 'Oldest Pending (days)', value: (r) => (r.oldestOpen == null ? '' : r.oldestOpen) },
]

/** Workbook: three summaries, then All / Open / Partly Corrected / Resolved. */
export function issueStatusSheets(report) {
  return [
    { name: 'Summary by Age', columns: AGE_SUMMARY_COLUMNS, rows: report.ageRows },
    { name: 'Summary by Category', columns: CATEGORY_SUMMARY_COLUMNS, rows: report.categoryRows },
    { name: 'Summary by Vendor', columns: VENDOR_SUMMARY_COLUMNS, rows: report.vendorRows },
    ...report.tabs.map((tab) => ({ name: tab.sheet, columns: ISSUE_STATUS_COLUMNS, rows: tab.rows })),
  ]
}
