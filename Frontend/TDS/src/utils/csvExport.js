import * as XLSX from 'xlsx'
import { jsPDF } from 'jspdf'
import { autoTable } from 'jspdf-autotable'
import { getDisplayIssueType, getRecommendedAction } from '@/data/issueTypes'
import { formatCurrency, formatDate, formatDateTime } from '@/utils/utils'

/** Columns for exporting `issue`-shaped rows (Issues Found, High, Medium). */
export const ISSUE_CSV_COLUMNS = [
  { label: 'Doc No.', value: (r) => r.docNo },
  { label: 'Vendor', value: (r) => r.vendor },
  { label: 'Vendor ID', value: (r) => r.vendorId },
  { label: 'Section', value: (r) => r.section },
  { label: 'Profit Center', value: (r) => r.profitCenter || '' },
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
  { label: 'Profit Center', value: (r) => r.profitCenter || '' },
  { label: 'Base Amount', value: (r) => formatCurrency(r.baseAmount) },
  { label: 'TDS Amount', value: (r) => formatCurrency(r.tdsAmount) },
  { label: 'TDS Note', value: (r) => r.tdsNote },
  { label: 'Credit Note / Correction For Doc', value: (r) => (r.rowKind === 'correction' ? r.correctionOf || '' : '') },
  { label: 'Validation Result', value: (r) => r.reason },
  { label: 'Date', value: (r) => formatDate(r.date) },
]

function csvEscape(value) {
  const str = value == null ? '' : String(value)
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
}

/**
 * Value written to CSV/Excel. A column may give `excelValue` (a plain number,
 * e.g. an amount) so the spreadsheet can sum and filter it; `value` stays the
 * formatted text shown on screen and in the PDF.
 */
function exportValue(column, row) {
  return column.excelValue ? column.excelValue(row) : column.value(row)
}

/** Header text for flat exports: a grouped column ("TDS Applicable") carries its group. */
function flatLabel(column) {
  return column.group ? `${column.group} - ${column.label}` : column.label
}

/**
 * columns: [{ label: 'Doc No.', value: (row) => row.docNo }, ...]
 * Triggers a browser download — no server round-trip, the CSV is built
 * entirely from data already loaded on the page.
 */
export function downloadCsv(filename, columns, rows) {
  const header = columns.map((c) => csvEscape(flatLabel(c))).join(',')
  const lines = rows.map((row) => columns.map((c) => csvEscape(exportValue(c, row))).join(','))
  // Leading BOM so Excel opens ₹ and other non-ASCII characters correctly.
  const csv = '\ufeff' + [header, ...lines].join('\r\n')
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

// Excel forbids these in sheet names and caps them at 31 characters.
function safeSheetName(name, used) {
  const base = String(name || 'Sheet').replace(/[\\/?*[\]:]/g, '-').slice(0, 31) || 'Sheet'
  let candidate = base
  for (let n = 2; used.has(candidate.toLowerCase()); n += 1) {
    candidate = `${base.slice(0, 31 - String(n).length - 1)} ${n}`
  }
  used.add(candidate.toLowerCase())
  return candidate
}

function buildWorksheet(columns, rows) {
  const hasGroups = columns.some((c) => c.group)
  const aoa = []
  if (hasGroups) {
    aoa.push(columns.map((c, i) => (c.group && columns[i - 1]?.group !== c.group ? c.group : null)))
  }
  aoa.push(columns.map((c) => c.label))
  rows.forEach((row) => {
    aoa.push(columns.map((c) => {
      const v = exportValue(c, row)
      return v === '' ? null : v
    }))
  })
  const worksheet = XLSX.utils.aoa_to_sheet(aoa)
  const headerRow = hasGroups ? 1 : 0

  if (hasGroups) {
    // One merged cell over each run of columns sharing a group ("TDS Applicable").
    const merges = []
    let start = null
    columns.forEach((c, i) => {
      if (c.group && columns[i - 1]?.group !== c.group) start = i
      if (c.group && columns[i + 1]?.group !== c.group && start != null && i > start) {
        merges.push({ s: { r: 0, c: start }, e: { r: 0, c: i } })
      }
    })
    worksheet['!merges'] = merges
  }
  if (columns.length) {
    worksheet['!autofilter'] = {
      ref: XLSX.utils.encode_range({ s: { r: headerRow, c: 0 }, e: { r: headerRow, c: columns.length - 1 } }),
    }
  }
  // Rough auto-width so columns aren't all default-width and unreadable.
  worksheet['!cols'] = columns.map((c) => ({
    wch: Math.min(60, Math.max(c.label.length, ...rows.slice(0, 200).map((r) => String(c.value(r) ?? '').length)) + 2),
  }))
  return worksheet
}

/**
 * One .xlsx workbook with several sheets: [{ name, columns, rows }].
 * Columns with the same `group` get a merged band above their headers.
 */
export function downloadWorkbook(filename, sheets) {
  const workbook = XLSX.utils.book_new()
  const used = new Set()
  sheets.forEach(({ name, columns, rows }) => {
    XLSX.utils.book_append_sheet(workbook, buildWorksheet(columns, rows), safeSheetName(name, used))
  })
  XLSX.writeFile(workbook, filename)
}

/** Same columns/rows shape as downloadCsv — a real .xlsx workbook instead of plain text. */
export function downloadExcel(filename, columns, rows, sheetName = 'Report') {
  downloadWorkbook(filename, [{ name: sheetName, columns, rows }])
}

/** Same columns/rows shape as downloadCsv — a landscape PDF with a title/timestamp header and a table. */
export function downloadPdf(filename, title, columns, rows) {
  const doc = new jsPDF({ orientation: 'landscape' })
  doc.setFontSize(14)
  doc.text(title, 14, 15)
  doc.setFontSize(9)
  doc.setTextColor(120)
  doc.text(`Generated ${formatDateTime(new Date())} · ${rows.length.toLocaleString()} row${rows.length === 1 ? '' : 's'}`, 14, 21)

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
