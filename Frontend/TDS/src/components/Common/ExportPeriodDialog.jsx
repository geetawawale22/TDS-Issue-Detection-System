import { useEffect, useMemo, useState } from 'react'
import { X, Download, FileSpreadsheet, FileText, CalendarDays } from 'lucide-react'
import {
  DATE_BASES, monthLabel, monthRange, monthsIn, rowsInPeriod,
} from '@/utils/reportPeriod'

const FORMATS = {
  csv: { label: 'CSV', icon: Download },
  excel: { label: 'Excel', icon: FileSpreadsheet },
  pdf: { label: 'PDF', icon: FileText },
}

const MODES = [
  { id: 'month', label: 'Month' },
  { id: 'range', label: 'Date range' },
  { id: 'all', label: 'All dates' },
]

/**
 * Asked before every report export: which month or date range to export.
 * `rows` are the report's source rows (they give the months on offer and
 * the "N records" preview); `onExport(period)` does the download.
 */
export default function ExportPeriodDialog({
  format, reportName, rows, initialPeriod, recordLabel = 'records', note, onCancel, onExport,
}) {
  const [mode, setMode] = useState(initialPeriod?.mode ?? 'month')
  const [basis, setBasis] = useState(initialPeriod?.basis ?? 'postingDate')
  const months = useMemo(() => monthsIn(rows, basis), [rows, basis])
  const [month, setMonth] = useState(
    initialPeriod?.mode === 'month' && initialPeriod.from ? initialPeriod.from.slice(0, 7) : '',
  )
  const [from, setFrom] = useState(initialPeriod?.mode === 'range' ? initialPeriod.from : '')
  const [to, setTo] = useState(initialPeriod?.mode === 'range' ? initialPeriod.to : '')

  // Latest month with data by default, and again if the basis has no such month.
  useEffect(() => {
    if (!months.includes(month)) setMonth(months[0] ?? '')
  }, [months, month])

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const period = useMemo(() => {
    if (mode === 'month') return month ? { mode, basis, ...monthRange(month) } : null
    if (mode === 'range') return from || to ? { mode, basis, from, to } : null
    return { mode: 'all', basis, from: '', to: '' }
  }, [mode, basis, month, from, to])

  const rangeInvalid = mode === 'range' && from && to && from > to
  const count = period && !rangeInvalid ? rowsInPeriod(rows, period).length : 0
  const { label: formatLabel, icon: FormatIcon } = FORMATS[format] ?? FORMATS.csv

  let hint = `${count.toLocaleString()} ${recordLabel} in this period.`
  if (mode === 'month' && months.length === 0) hint = 'No dated rows to export.'
  else if (mode === 'range' && !from && !to) hint = 'Choose a from date, a to date, or both.'
  else if (rangeInvalid) hint = 'The from date is after the to date.'

  return (
    // Stop clicks here reaching a report viewer behind it, whose backdrop
    // click would close the viewer too.
    <div className="modal-overlay export-period-overlay" onClick={(e) => { e.stopPropagation(); onCancel() }}>
      <div
        className="export-period-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-period-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="report-modal-header">
          <div style={{ minWidth: 0 }}>
            <h3 id="export-period-title" className="settings-card-title">Export {formatLabel}</h3>
            <p className="report-modal-desc">{reportName}{note ? ` · ${note}` : ''}</p>
          </div>
          <button className="issue-drawer-close" onClick={onCancel} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="export-period-body">
          <div className="export-period-label"><CalendarDays size={13} />Which period should be exported?</div>

          <div className="export-period-modes" role="radiogroup" aria-label="Period">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={mode === m.id}
                className={`report-tab ${mode === m.id ? 'active' : ''}`}
                onClick={() => setMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>

          {mode !== 'all' && (
            <label className="export-period-field">
              <span>Date based on</span>
              <select className="filter-select" value={basis} onChange={(e) => setBasis(e.target.value)}>
                {DATE_BASES.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
              </select>
            </label>
          )}

          {mode === 'month' && (
            <label className="export-period-field">
              <span>Month</span>
              <select className="filter-select" value={month} onChange={(e) => setMonth(e.target.value)} disabled={months.length === 0}>
                {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
              </select>
            </label>
          )}

          {mode === 'range' && (
            <div className="export-period-range">
              <label className="export-period-field">
                <span>From</span>
                <input className="filter-input" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label className="export-period-field">
                <span>To</span>
                <input className="filter-input" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
              </label>
            </div>
          )}

          <p className={`export-period-hint ${count === 0 ? 'is-empty' : ''}`}>{hint}</p>
        </div>

        <div className="export-period-actions">
          <button className="btn btn-outline btn-sm" type="button" onClick={onCancel}>Cancel</button>
          <button
            className="btn btn-primary btn-sm"
            type="button"
            disabled={!period || rangeInvalid || count === 0}
            onClick={() => onExport(period)}
          >
            <FormatIcon size={12} />Export {formatLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
