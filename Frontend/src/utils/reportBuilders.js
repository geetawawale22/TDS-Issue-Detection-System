import { getDisplayIssueType } from '@/data/issueTypes'
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
    { label: 'Total Tax Impact', value: (r) => formatCurrency(r.taxImpact) },
  ]
  return { columns, rows }
}

// ── 3. Exception Report — No TDS Deduction / Not Applicable ────────────
const EXCEPTION_CATEGORY_RE = /Not Deducted|Not Applicable/i

export function buildExceptionReport(issues) {
  const rows = issues.filter((i) => i.isViolation && EXCEPTION_CATEGORY_RE.test(i.category || ''))
  const columns = [
    { label: 'Doc No.', value: (r) => r.docNo },
    { label: 'Vendor', value: (r) => r.vendor },
    { label: 'PAN', value: (r) => r.vendorPan },
    { label: 'Section', value: (r) => r.section },
    { label: 'Base Amount', value: (r) => formatCurrency(r.baseAmount) },
    { label: 'TDS Amount', value: (r) => formatCurrency(r.tdsAmount) },
    { label: 'Category', value: (r) => getDisplayIssueType(r) },
    { label: 'Severity', value: (r) => r.severity },
    { label: 'Date', value: (r) => formatDate(r.date) },
  ]
  return { columns, rows }
}

// ── 4. PAN-level report ──────────────────────────────────────────────
export function buildPanLevelReport(issues) {
  const byPan = new Map()
  for (const i of issues) {
    const pan = i.vendorPan && i.vendorPan !== '—' ? i.vendorPan : 'No PAN'
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
    { label: 'Total Base Amount', value: (r) => formatCurrency(r.baseAmount) },
    { label: 'Total TDS Amount', value: (r) => formatCurrency(r.tdsAmount) },
    { label: 'Total Tax Impact', value: (r) => formatCurrency(r.taxImpact) },
  ]
  return { columns, rows }
}

// ── 5. TDS Deduction Report — Correct / Short / Excess / No Deduction / Not Applicable
// One row per transaction (not just flagged issues), each tagged with its
// bucket and vendor, so a "Short" or "Excess" finding can be traced back to
// the specific vendor/document it belongs to — not just a bucket total.
const BUCKET_ORDER = ['Correct', 'Short', 'Excess', 'No Deduction', 'Not Applicable', 'Insufficient Data', 'Other']

function classifyValidationRow(row) {
  if (row.status === 'passed') return 'Correct'
  if (row.status === 'insufficient') return 'Insufficient Data'
  const reason = row.reason || ''
  if (/Short/i.test(reason)) return 'Short'
  if (/Excess/i.test(reason)) return 'Excess'
  if (/Not Deducted/i.test(reason)) return 'No Deduction'
  if (/Not Applicable/i.test(reason)) return 'Not Applicable'
  return 'Other'
}

export function buildDeductionBifurcationReport(validationRows) {
  const rows = validationRows
    .map((row) => ({ ...row, bucket: classifyValidationRow(row) }))
    .sort((a, b) => (
      BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket)
      || (a.vendor || '').localeCompare(b.vendor || '')
    ))

  const columns = [
    { label: 'Category', value: (r) => r.bucket },
    { label: 'Vendor', value: (r) => r.vendor },
    { label: 'Doc No.', value: (r) => r.docNo },
    { label: 'Section', value: (r) => r.section },
    { label: 'Base Amount', value: (r) => formatCurrency(r.baseAmount) },
    { label: 'Rate (%)', value: (r) => r.appliedRate != null ? `${r.appliedRate}%` : '—' },
    { label: 'TDS Amount', value: (r) => formatCurrency(r.tdsAmount) },
    { label: 'Date', value: (r) => formatDate(r.date) },
  ]
  return { columns, rows }
}

// ── 6. LDC & Threshold Monitoring report ────────────────────────────────
const LDC_THRESHOLD_RE = /LDC|Threshold Crossed|Premature Deduction/i

export function buildLdcThresholdReport(issues) {
  const rows = issues.filter((i) => LDC_THRESHOLD_RE.test(i.category || ''))
  const columns = [
    { label: 'Doc No.', value: (r) => r.docNo },
    { label: 'Vendor', value: (r) => r.vendor },
    { label: 'PAN', value: (r) => r.vendorPan },
    { label: 'Section', value: (r) => r.section },
    { label: 'Category', value: (r) => getDisplayIssueType(r) },
    { label: 'Base Amount', value: (r) => formatCurrency(r.baseAmount) },
    { label: 'TDS Amount', value: (r) => formatCurrency(r.tdsAmount) },
    { label: 'Severity', value: (r) => r.severity },
    { label: 'Date', value: (r) => formatDate(r.date) },
  ]
  return { columns, rows }
}
