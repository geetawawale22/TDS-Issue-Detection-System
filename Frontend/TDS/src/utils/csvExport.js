import { getDisplayIssueType, getRecommendedAction } from '@/data/issueTypes'
import { formatCurrency, formatDate } from '@/utils/utils'

/** Columns for exporting `issue`-shaped rows (Issues Found, High, Medium). */
export const ISSUE_CSV_COLUMNS = [
  { label: 'Doc No.', value: (r) => r.docNo },
  { label: 'Vendor', value: (r) => r.vendor },
  { label: 'Vendor ID', value: (r) => r.vendorId },
  { label: 'Section', value: (r) => r.section },
  { label: 'Base Amount', value: (r) => formatCurrency(r.baseAmount) },
  { label: 'TDS Amount', value: (r) => formatCurrency(r.tdsAmount) },
  { label: 'Issue Type', value: (r) => getDisplayIssueType(r) },
  { label: 'Severity', value: (r) => r.severity },
  { label: 'Recommended Action', value: (r) => getRecommendedAction(r) },
  { label: 'Date', value: (r) => formatDate(r.date) },
]

/** Columns for exporting validation-row-shaped data (Transactions, Passed, Insufficient Data). */
export const VALIDATION_CSV_COLUMNS = [
  { label: 'Doc No.', value: (r) => r.docNo },
  { label: 'Vendor', value: (r) => r.vendor },
  { label: 'Vendor ID', value: (r) => r.vendorId },
  { label: 'Section', value: (r) => r.section },
  { label: 'Base Amount', value: (r) => formatCurrency(r.baseAmount) },
  { label: 'TDS Amount', value: (r) => formatCurrency(r.tdsAmount) },
  { label: 'Validation Result', value: (r) => r.reason },
  { label: 'Date', value: (r) => formatDate(r.date) },
]

function csvEscape(value) {
  const str = value == null ? '' : String(value)
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
}

/**
 * columns: [{ label: 'Doc No.', value: (row) => row.docNo }, ...]
 * Triggers a browser download — no server round-trip, the CSV is built
 * entirely from data already loaded on the page.
 */
export function downloadCsv(filename, columns, rows) {
  const header = columns.map((c) => csvEscape(c.label)).join(',')
  const lines = rows.map((row) => columns.map((c) => csvEscape(c.value(row))).join(','))
  // Leading BOM so Excel opens ₹ and other non-ASCII characters correctly.
  const csv = '﻿' + [header, ...lines].join('\r\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
