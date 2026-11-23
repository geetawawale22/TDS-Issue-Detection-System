import { formatCurrency, formatDate } from '@/utils/utils'

function monthKey(dateStr) {
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return null
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function monthLabel(key) {
  const [y, m] = key.split('-')
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })
}

function pctChange(current, previous) {
  if (previous == null) return null
  if (previous === 0) return current === 0 ? 0 : null
  return ((current - previous) / previous) * 100
}

// Excel cell for an amount: a real number (sums/filters work), blank when absent.
function amountCell(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
}

function formatPct(v) {
  if (v == null) return '-'
  const sign = v > 0 ? '+' : ''
  return `${sign}${v.toFixed(1)}%`
}

// ── 1. Month-on-Month comparison (overall) ─────────────────────────────
export function buildMonthlyComparisonReport(issues) {
  const byMonth = new Map()
  for (const i of issues) {
    const key = monthKey(i.date)
    if (!key) continue
    if (!byMonth.has(key)) byMonth.set(key, { month: key, total: 0, high: 0, medium: 0, low: 0 })
    const row = byMonth.get(key)
    row.total += 1
    row[i.severity] = (row[i.severity] || 0) + 1
  }
  const sorted = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month))
  const rows = sorted.map((row, idx) => ({
    ...row,
    monthLabel: monthLabel(row.month),
    change: pctChange(row.total, sorted[idx - 1]?.total ?? null),
  }))

  const columns = [
    { label: 'Month', value: (r) => r.monthLabel },
    { label: 'Total Issues', value: (r) => r.total },
    { label: 'High', value: (r) => r.high || 0 },
    { label: 'Medium', value: (r) => r.medium || 0 },
    { label: 'Low', value: (r) => r.low || 0 },
    { label: '% Change vs Prior Month', value: (r) => formatPct(r.change) },
  ]
  return { columns, rows }
}

// ── 2. Vendor-wise Month-on-Month comparison ────────────────────────────
export function buildVendorMonthlyReport(issues) {
  const byKey = new Map()
  for (const i of issues) {
    const key = monthKey(i.date)
    if (!key || !i.vendor) continue
    const mapKey = `${i.vendor}||${key}`
    if (!byKey.has(mapKey)) byKey.set(mapKey, { vendor: i.vendor, month: key, count: 0, taxImpact: 0 })
    const row = byKey.get(mapKey)
    row.count += 1
    row.taxImpact += Math.abs(Number(i.taxImpact) || 0)
  }
  const rows = [...byKey.values()]
    .map((r) => ({ ...r, monthLabel: monthLabel(r.month) }))
    .sort((a, b) => a.vendor.localeCompare(b.vendor) || a.month.localeCompare(b.month))

  const columns = [
    { label: 'Vendor', value: (r) => r.vendor },
    { label: 'Month', value: (r) => r.monthLabel },
    { label: 'Issue Count', value: (r) => r.count },
    { label: 'Total Tax Impact', value: (r) => formatCurrency(r.taxImpact), excelValue: (r) => amountCell(r.taxImpact) },
  ]
  return { columns, rows }
}

// ── 3. PAN-level report ──────────────────────────────────────────────
export function buildPanLevelReport(issues) {
  const byPan = new Map()
  for (const i of issues) {
    const pan = i.vendorPan && i.vendorPan !== '-' ? i.vendorPan : 'No PAN'
    if (!byPan.has(pan)) byPan.set(pan, { pan, vendors: new Set(), issueCount: 0, baseAmount: 0, tdsAmount: 0, taxImpact: 0 })
    const row = byPan.get(pan)
    row.vendors.add(i.vendor)
    row.issueCount += 1
    row.baseAmount += Number(i.baseAmount) || 0
    row.tdsAmount += Math.abs(Number(i.tdsAmount) || 0)
    row.taxImpact += Math.abs(Number(i.taxImpact) || 0)
  }
  const rows = [...byPan.values()]
    .map((r) => ({ ...r, vendorList: [...r.vendors].join(', ') }))
    .sort((a, b) => b.issueCount - a.issueCount)

  const columns = [
    { label: 'PAN', value: (r) => r.pan },
    { label: 'Vendor(s)', value: (r) => r.vendorList },
    { label: 'Issue Count', value: (r) => r.issueCount },
    { label: 'Total Base Amount', value: (r) => formatCurrency(r.baseAmount), excelValue: (r) => amountCell(r.baseAmount) },
    { label: 'Total TDS Amount', value: (r) => formatCurrency(r.tdsAmount), excelValue: (r) => amountCell(r.tdsAmount) },
    { label: 'Total Tax Impact', value: (r) => formatCurrency(r.taxImpact), excelValue: (r) => amountCell(r.taxImpact) },
  ]
  return { columns, rows }
}

// ── 5. TDS Category Report ──────────────────────────────────────────────
// Mirrors the business scenario workbook: one sheet per category, the TDS
// that was applicable next to the TDS that was deducted, and a remark. Every
// transaction (validationRows), not only issues, because several categories
// (Properly Deducted, Not Applicable, LDC, advances) are mostly correct rows.
// The backend assigns `reportCategory` (services/report_category.py).
export const REPORT_CATEGORIES = [
  { id: 'properly_deducted', label: 'TDS Properly Deducted', sheet: 'TDS Properly Deducted' },
  { id: 'not_applicable', label: 'TDS Not Applicable', sheet: 'TDS not Applicable' },
  { id: 'short', label: 'Short TDS Deducted', sheet: 'Short TDS Deducted' },
  { id: 'excess', label: 'Excess TDS Deducted', sheet: 'Excess TDS Deducted' },
  { id: 'ldc', label: 'TDS Deducted as per LDC', sheet: 'TDS Deducted as per LDC' },
  { id: 'not_deducted', label: 'TDS Not Deducted', sheet: 'TDS Not Deducted' },
  { id: 'advance_full', label: '100% TDS on Advance', sheet: '100% TDS on Adv' },
  { id: 'advance_partial', label: 'Partial TDS on Advance', sheet: 'Partial TDS on Adv' },
  // Not a business sheet: rows whose issue a correction, reversal or manual
  // review resolved. Kept apart so the sheets above hold open issues only and
  // their issue count matches Open Issues for the upload.
  { id: 'resolved', label: 'Resolved Issues', sheet: 'Resolved Issues' },
  { id: 'other', label: 'Other / Needs Review', sheet: 'Other - Needs Review' },
]

const CATEGORY_LABEL = Object.fromEntries(REPORT_CATEGORIES.map((c) => [c.id, c.label]))

export const ROW_STATUS_LABELS = {
  passed: 'Correct',
  issue: 'Issue',
  corrected: 'Resolved',
  insufficient: 'Insufficient Data',
  skipped: 'Not Validated',
}

export function reportCategoryLabel(id) {
  return CATEGORY_LABEL[id] || CATEGORY_LABEL.other
}

// "Resolved Issues (was Short TDS Deducted)" for a resolved row.
function rowCategoryLabel(row) {
  const label = reportCategoryLabel(row.reportCategory)
  return row.reportCategory === 'resolved' && row.resolvedFrom
    ? `${label} (was ${reportCategoryLabel(row.resolvedFrom)})`
    : label
}

export function rowStatusLabel(row) {
  return ROW_STATUS_LABELS[row.status] || row.status || ''
}

function blank(v) {
  return v == null || v === '—' || v === '-' ? '' : v
}

function rateText(v) {
  if (v == null || v === '' || !Number.isFinite(Number(v))) return ''
  return `${Number(Number(v).toFixed(4))}%`
}

function moneyText(v) {
  return v == null || v === '' ? '' : formatCurrency(v)
}

// TDS deducted on the document; for a document a later correction fixed,
// the posted TDS plus the top-up (reportTdsAmount, set by the backend).
export function deductedAmount(row) {
  if (row.reportTdsAmount != null) return Math.abs(Number(row.reportTdsAmount) || 0)
  return Math.abs(Number(row.tdsAmount) || 0)
}

// A correction line whose TDS is already in its original document's
// deducted amount; its amounts are left out of totals so they count once.
export function countsInTotals(row) {
  return !row.reportCountedOn
}

function linkedDoc(row) {
  if (row.linkedDoc) return row.linkedDoc
  return row.rowKind === 'correction' ? blank(row.correctionOf) : ''
}

// SAP signs amounts by debit/credit (an invoice's base is negative); the
// business workbook shows them as plain amounts, like the TDS columns.
function magnitude(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? Math.abs(n) : null
}

// Rate as keyed in SAP (2%), not the rate implied by amount ÷ base (2.0001%);
// rows from uploads made before deductedRate existed fall back to the latter.
function deductedRate(row) {
  return row.deductedRate ?? row.appliedRate
}

// Same columns, in the same order, as the business workbook ("TDS Devlopement
// IT"), except Person and PO Number, which Mahindra's SAP data does not carry;
// Line Item, Status, Linked Doc and Issue Type are added after Remark.
// Used for the on-screen table, CSV and every Excel sheet. `numeric` columns
// sort and align as numbers; `wide` columns wrap.
export const CATEGORY_REPORT_COLUMNS = [
  { id: 'serial', label: 'S.No.', value: (r) => r.serial, numeric: true },
  { id: 'category', label: 'Category', value: (r) => rowCategoryLabel(r) },
  { id: 'companyCode', label: 'Company Code', value: (r) => blank(r.companyCode) },
  { id: 'vendorCode', label: 'Vendor Code', value: (r) => blank(r.vendorId) },
  { id: 'vendorName', label: 'Vendor Name', value: (r) => blank(r.vendor), wide: true },
  { id: 'pan', label: 'PAN', value: (r) => blank(r.vendorPan) },
  { id: 'billDate', label: 'Bill Date', value: (r) => (r.documentDate ? formatDate(r.documentDate) : ''), sortValue: (r) => r.documentDate || '' },
  { id: 'billNo', label: 'Bill No.', value: (r) => blank(r.billNo) },
  { id: 'gl', label: 'GL', value: (r) => blank(r.glAccount) },
  { id: 'glDescription', label: 'GL Description', value: (r) => blank(r.glDescription), wide: true },
  { id: 'description', label: 'Description', value: (r) => blank(r.txnDescription), wide: true },
  { id: 'billAmount', label: 'Bill Amount', value: (r) => moneyText(magnitude(r.billAmount)), excelValue: (r) => amountCell(magnitude(r.billAmount)), numeric: true },
  { id: 'basicAmount', label: 'Basic Amount', value: (r) => moneyText(magnitude(r.baseAmount)), excelValue: (r) => amountCell(magnitude(r.baseAmount)), numeric: true },
  { id: 'postingDate', label: 'Posting Date', value: (r) => formatDate(r.postingDate || r.date), sortValue: (r) => r.postingDate || r.date || '' },
  { id: 'docType', label: 'Document Type', value: (r) => blank(r.docType) },
  { id: 'docNo', label: 'Document No.', value: (r) => blank(r.docNo) },
  { id: 'lineItem', label: 'Line Item', value: (r) => blank(r.lineItem) },
  { id: 'applicableSection', group: 'TDS Applicable', label: 'TDS Section', value: (r) => blank(r.applicableSection) },
  { id: 'applicableRate', group: 'TDS Applicable', label: 'TDS Rate (%)', value: (r) => rateText(r.applicableRate), excelValue: (r) => amountCell(r.applicableRate), numeric: true },
  { id: 'applicableAmount', group: 'TDS Applicable', label: 'TDS Amount', value: (r) => moneyText(r.applicableAmount), excelValue: (r) => amountCell(r.applicableAmount), numeric: true },
  { id: 'deductedSection', group: 'TDS Deducted', label: 'TDS Section', value: (r) => blank(r.deductedSection) },
  {
    id: 'deductedRate',
    group: 'TDS Deducted',
    label: 'TDS Rate (%)',
    value: (r) => (deductedAmount(r) > 0 ? rateText(deductedRate(r)) : ''),
    excelValue: (r) => (deductedAmount(r) > 0 ? amountCell(deductedRate(r)) : null),
    numeric: true,
  },
  { id: 'deductedAmount', group: 'TDS Deducted', label: 'TDS Amount', value: (r) => moneyText(deductedAmount(r)), excelValue: (r) => amountCell(deductedAmount(r)), numeric: true },
  { id: 'remark', label: 'Remark', value: (r) => blank(r.remark), wide: true },
  { id: 'status', label: 'Status', value: (r) => rowStatusLabel(r) },
  { id: 'linkedDoc', label: 'Linked Doc', value: (r) => linkedDoc(r) },
  { id: 'issueType', label: 'Issue Type', value: (r) => blank(r.issueCategory), wide: true },
]

function withSerial(rows) {
  return rows.map((row, i) => ({ ...row, serial: i + 1 }))
}

function summarise(rows) {
  let applicable = 0
  let deducted = 0
  let base = 0
  let issues = 0
  let resolved = 0
  let difference = 0
  let unverified = 0
  for (const row of rows) {
    if (row.status === 'issue') issues += 1
    if (row.status === 'corrected') resolved += 1
    if (!countsInTotals(row)) continue
    const known = row.applicableAmount != null
    applicable += Number(row.applicableAmount) || 0
    deducted += deductedAmount(row)
    base += magnitude(row.baseAmount) || 0
    // Only rows whose applicable TDS is known (the rules worked out a rate)
    // count towards the difference; the rest would show as fake excess.
    if (known) difference += (Number(row.applicableAmount) || 0) - deductedAmount(row)
    else if (deductedAmount(row) > 0) unverified += 1
  }
  return { count: rows.length, issues, resolved, base, applicable, deducted, difference, unverified }
}

export const CATEGORY_SUMMARY_COLUMNS = [
  { label: 'Category', value: (r) => r.label },
  { label: 'Transactions', value: (r) => r.count },
  { label: 'Open Issues', value: (r) => r.issues },
  { label: 'Resolved', value: (r) => r.resolved },
  { label: 'Basic Amount', value: (r) => formatCurrency(r.base), excelValue: (r) => amountCell(r.base) },
  { label: 'TDS Applicable', value: (r) => formatCurrency(r.applicable), excelValue: (r) => amountCell(r.applicable) },
  { label: 'TDS Deducted', value: (r) => formatCurrency(r.deducted), excelValue: (r) => amountCell(r.deducted) },
  { label: 'Short (+) / Excess (−)', value: (r) => formatCurrency(r.difference), excelValue: (r) => amountCell(r.difference) },
  { label: 'Rate Not Verified', value: (r) => r.unverified },
]

/**
 * { hasCategories, tabs: [{ id, label, sheet, rows, summary }], summaryRows }
 * `tabs[0]` is "All". Rows from an upload made before categories existed
 * have no reportCategory; `hasCategories` is then false and the page asks
 * for a fresh upload instead of showing everything as "Other".
 */
export function buildCategoryReport(validationRows) {
  const hasCategories = validationRows.some((row) => row.reportCategory)
  const byCategory = new Map(REPORT_CATEGORIES.map((c) => [c.id, []]))
  for (const row of validationRows) {
    const id = byCategory.has(row.reportCategory) ? row.reportCategory : 'other'
    byCategory.get(id).push(row)
  }
  const ordered = REPORT_CATEGORIES.flatMap((c) => byCategory.get(c.id))
  const tabs = [
    { id: 'all', label: 'All', sheet: 'All', rows: withSerial(ordered), summary: summarise(ordered) },
    ...REPORT_CATEGORIES.map((c) => {
      const rows = byCategory.get(c.id)
      return { ...c, rows: withSerial(rows), summary: summarise(rows) }
    }),
  ]
  const summaryRows = [
    ...tabs.slice(1).map((tab) => ({ label: tab.label, ...tab.summary })),
    { label: 'Total', ...tabs[0].summary },
  ]
  return { hasCategories, tabs, summaryRows }
}

/** Sheets for the category workbook: Summary, All, then one per category. */
export function categoryReportSheets(report) {
  return [
    { name: 'Summary', columns: CATEGORY_SUMMARY_COLUMNS, rows: report.summaryRows },
    ...report.tabs.map((tab) => ({ name: tab.sheet, columns: CATEGORY_REPORT_COLUMNS, rows: tab.rows })),
  ]
}
