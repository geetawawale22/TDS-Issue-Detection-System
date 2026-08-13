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

function pctChange(current, previous) {
  if (previous == null) return null
  if (previous === 0) return current === 0 ? 0 : null
  return ((current - previous) / previous) * 100
}

function formatPct(v) {
  if (v == null) return '—'
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
// Built from validationRows (every transaction, not just flagged issues) so
// "Correct" has a real count — a report bifurcating deduction outcomes has
// to include the compliant majority, not just the exceptions.
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
  const byBucket = new Map()
  for (const row of validationRows) {
    const bucket = classifyValidationRow(row)
    if (!byBucket.has(bucket)) byBucket.set(bucket, { bucket, count: 0, baseAmount: 0, tdsAmount: 0 })
    const r = byBucket.get(bucket)
    r.count += 1
    r.baseAmount += Number(row.baseAmount) || 0
    r.tdsAmount += Math.abs(Number(row.tdsAmount) || 0)
  }
  const total = validationRows.length || 1
  const rows = BUCKET_ORDER
    .filter((b) => byBucket.has(b))
    .map((b) => {
      const r = byBucket.get(b)
      return { ...r, pct: (r.count / total) * 100 }
    })

  const columns = [
    { label: 'Category', value: (r) => r.bucket },
    { label: 'Count', value: (r) => r.count },
    { label: '% of Total', value: (r) => `${r.pct.toFixed(1)}%` },
    { label: 'Total Base Amount', value: (r) => formatCurrency(r.baseAmount) },
    { label: 'Total TDS Amount', value: (r) => formatCurrency(r.tdsAmount) },
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
