/**
 * Report export period: every export asks for a month, a date range or all
 * dates first (ExportPeriodDialog), then only rows in that period go out.
 *
 * A period is { mode: 'month' | 'range' | 'all', basis, from, to } where
 * from/to are 'YYYY-MM-DD' (a month is turned into its first and last day).
 */
import { formatDate } from '@/utils/utils'

export const DATE_BASES = [
  { id: 'postingDate', label: 'Posting Date', of: (row) => row.postingDate || row.date },
  { id: 'billDate', label: 'Bill Date', of: (row) => row.documentDate },
]

export const ALL_DATES = { mode: 'all', basis: 'postingDate', from: '', to: '' }

export function dateKey(value) {
  const key = String(value || '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : ''
}

function dateOf(basis) {
  return (DATE_BASES.find((b) => b.id === basis) ?? DATE_BASES[0]).of
}

export function monthRange(month) {
  const [y, m] = month.split('-').map(Number)
  const last = new Date(y, m, 0).getDate()
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` }
}

export function monthLabel(month) {
  const [y, m] = month.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })
}

/** 'YYYY-MM' months present in the rows for the date basis, newest first. */
export function monthsIn(rows, basis = 'postingDate') {
  const of = dateOf(basis)
  const months = new Set()
  for (const row of rows) {
    const key = dateKey(of(row))
    if (key) months.add(key.slice(0, 7))
  }
  return [...months].sort().reverse()
}

/** Rows whose date falls in the period; rows without that date are left out once a period is set. */
export function rowsInPeriod(rows, period) {
  if (!period || period.mode === 'all' || (!period.from && !period.to)) return rows
  const of = dateOf(period.basis)
  return rows.filter((row) => {
    const key = dateKey(of(row))
    if (!key) return false
    return (!period.from || key >= period.from) && (!period.to || key <= period.to)
  })
}

export function periodLabel(period) {
  if (!period || period.mode === 'all') return 'All dates'
  const basis = (DATE_BASES.find((b) => b.id === period.basis) ?? DATE_BASES[0]).label
  if (period.mode === 'month' && period.from) return `${basis}: ${monthLabel(period.from.slice(0, 7))}`
  const from = period.from ? formatDate(period.from) : 'start'
  const to = period.to ? formatDate(period.to) : 'end'
  return `${basis}: ${from} to ${to}`
}

/** Appended to the file name, e.g. "-2026-04" or "-2026-04-01-to-2026-04-15". */
export function periodFileSuffix(period) {
  if (!period || period.mode === 'all' || (!period.from && !period.to)) return ''
  if (period.mode === 'month') return `-${period.from.slice(0, 7)}`
  return `-${period.from || 'start'}-to-${period.to || 'end'}`
}
