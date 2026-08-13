import * as XLSX from 'xlsx'
import { jsPDF } from 'jspdf'
import { autoTable } from 'jspdf-autotable'
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

/** Same columns/rows shape as downloadCsv — a real .xlsx workbook instead of plain text. */
export function downloadExcel(filename, columns, rows, sheetName = 'Report') {
  const data = rows.map((row) => {
    const obj = {}
    columns.forEach((c) => { obj[c.label] = c.value(row) })
    return obj
  })
  const worksheet = XLSX.utils.json_to_sheet(data)
  // Rough auto-width so columns aren't all default-width and unreadable.
  worksheet['!cols'] = columns.map((c) => ({
    wch: Math.max(c.label.length, ...rows.slice(0, 200).map((r) => String(c.value(r) ?? '').length)) + 2,
  }))
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName.slice(0, 31)) // Excel sheet-name limit
  XLSX.writeFile(workbook, filename)
}

/** Same columns/rows shape as downloadCsv — a landscape PDF with a title/timestamp header and a table. */
export function downloadPdf(filename, title, columns, rows) {
  const doc = new jsPDF({ orientation: 'landscape' })
  doc.setFontSize(14)
  doc.text(title, 14, 15)
  doc.setFontSize(9)
  doc.setTextColor(120)
  doc.text(`Generated ${new Date().toLocaleString('en-IN')} · ${rows.length.toLocaleString()} row${rows.length === 1 ? '' : 's'}`, 14, 21)

  autoTable(doc, {
    startY: 26,
    head: [columns.map((c) => c.label)],
    body: rows.map((row) => columns.map((c) => {
      const v = c.value(row)
      return v == null ? '' : String(v)
    })),
    styles: { fontSize: 7, cellPadding: 2.5, overflow: 'linebreak' },
    headStyles: { fillColor: [224, 19, 48], textColor: 255, fontStyle: 'bold' }, // Mahindra red
    alternateRowStyles: { fillColor: [250, 250, 250] },
    margin: { left: 14, right: 14 },
  })

  doc.save(filename)
}
