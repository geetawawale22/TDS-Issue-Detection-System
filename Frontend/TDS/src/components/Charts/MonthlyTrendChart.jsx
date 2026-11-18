import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, LabelList, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { useEffect, useMemo, useState } from 'react'
import { useSelector } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import { selectMonthlyTrend, selectSectionMonthlyTrend } from '@/redux/slices/issuesSlice'
import { SECTION_TREND_OTHERS } from '@/utils/liveAnalytics'
import './Charts.css'

const VIEWS = [
  { key: 'total', label: 'Total' },
  { key: 'section', label: 'By Section' },
  { key: 'compare', label: 'Compare' },
]
const SECTION_COLORS = ['#2F6FDE', '#E0892B', '#12A190', '#8B5CD6', '#D9488F', '#A3AAB8']
const COMPARE_COLORS = { a: '#9DB8EA', b: '#2F6FDE' }

const monthLabel = (row) => (row?.monthKey ? `${row.month} ${String(row.monthKey).slice(0, 4)}` : row?.month || '')
const sectionColor = (sections, section) => (section === SECTION_TREND_OTHERS
  ? SECTION_COLORS[SECTION_COLORS.length - 1]
  : SECTION_COLORS[sections.indexOf(section) % (SECTION_COLORS.length - 1)])

export default function MonthlyTrendChart({ onMonthClick, height = 200 }) {
  const data = useSelector(selectMonthlyTrend)
  const sectionTrend = useSelector(selectSectionMonthlyTrend)
  const navigate = useNavigate()
  const [view, setView] = useState('total')
  const [hoveredIndex, setHoveredIndex] = useState(null)
  const [compareA, setCompareA] = useState('')
  const [compareB, setCompareB] = useState('')
  const { sections, months } = sectionTrend
  const monthKeys = months.map((row) => row.monthKey).join('|')

  // Compare defaults to the latest two months; reset when the months change.
  useEffect(() => {
    const keys = monthKeys ? monthKeys.split('|') : []
    setCompareB((current) => (keys.includes(current) ? current : keys[keys.length - 1] || ''))
    setCompareA((current) => (keys.includes(current) ? current : keys[keys.length - 2] || keys[0] || ''))
  }, [monthKeys])

  const yearLabel = useMemo(() => {
    const years = [...new Set(data
      .map((row) => String(row.monthKey || '').slice(0, 4))
      .filter(Boolean))]
    if (years.length === 0) return ''
    if (years.length === 1) return years[0]
    return `${years[0]} - ${years[years.length - 1]}`
  }, [data])

  // Others is a group, not a section the Issues tab can filter on, so it opens
  // the whole month.
  function openMonth(point, section) {
    if (!point?.monthKey) return
    const target = { ...point, section: section && section !== SECTION_TREND_OTHERS ? section : undefined }
    if (onMonthClick) onMonthClick(target)
    else {
      const params = new URLSearchParams({ view: 'issue', month: point.monthKey })
      if (target.section) params.set('section', target.section)
      navigate(`/issues?${params.toString()}`)
    }
  }

  function renderTotalTooltip({ active, payload }) {
    const point = payload?.[0]?.payload
    if (!active || !point) return null
    return (
      <div className="monthly-trend-tooltip">
        <div className="monthly-trend-tooltip-month">{monthLabel(point)}</div>
        <div className="monthly-trend-tooltip-value monthly-trend-tooltip-value--issues">Issues: {point.issues}</div>
        <div className="monthly-trend-tooltip-value monthly-trend-tooltip-value--resolved">Resolved: {point.resolved}</div>
        <button type="button" className="monthly-trend-tooltip-action" onClick={() => openMonth(point)}>
          Open month issues
        </button>
      </div>
    )
  }

  function renderSectionTooltip({ active, payload }) {
    const point = payload?.[0]?.payload
    if (!active || !point) return null
    return (
      <div className="monthly-trend-tooltip">
        <div className="monthly-trend-tooltip-month">{monthLabel(point)} · {point.total} issues</div>
        {[...sections].reverse().filter((section) => point[section]).map((section) => (
          <div key={section} className="monthly-trend-tooltip-value" style={{ color: sectionColor(sections, section) }}>
            {section}: {point[section]}
          </div>
        ))}
        <div className="monthly-trend-tooltip-hint">Click a section to open its issues</div>
      </div>
    )
  }

  function renderTotal() {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart
          data={data}
          margin={{ top: 2, right: 4, left: -20, bottom: 0 }}
          onMouseMove={(state) => {
            if (Number.isInteger(state?.activeTooltipIndex)) setHoveredIndex(state.activeTooltipIndex)
          }}
          onClick={(state) => {
            const index = Number.isInteger(state?.activeTooltipIndex) ? state.activeTooltipIndex : hoveredIndex
            if (Number.isInteger(index)) openMonth(data[index])
          }}
        >
          <defs>
            <linearGradient id="issueGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#E01330" stopOpacity={0.15} />
              <stop offset="95%" stopColor="#E01330" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="resolvedGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#10B981" stopOpacity={0.15} />
              <stop offset="95%" stopColor="#10B981" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
          <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#64748B' }} axisLine={{ stroke: '#E5E7EB' }} tickLine={false} />
          <YAxis tick={{ fontSize: 11, fill: '#64748B' }} axisLine={false} tickLine={false} />
          <Tooltip content={renderTotalTooltip} cursor={{ stroke: '#E5E7EB' }} />
          <Legend iconType="circle" iconSize={8} formatter={(v) => <span style={{ fontSize: 11, color: '#64748B' }}>{v}</span>} />
          <Area type="monotone" dataKey="issues" stroke="#E01330" strokeWidth={2} fill="url(#issueGrad)" name="Issues" dot={false} />
          <Area type="monotone" dataKey="resolved" stroke="#10B981" strokeWidth={2} fill="url(#resolvedGrad)" name="Resolved" dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    )
  }

  function renderBySection() {
    if (!months.length) return <div className="monthly-trend-empty" style={{ height }}>No dated issues to show.</div>
    return (
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={months} margin={{ top: 14, right: 4, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
          <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#64748B' }} axisLine={{ stroke: '#E5E7EB' }} tickLine={false} />
          <YAxis tick={{ fontSize: 11, fill: '#64748B' }} axisLine={false} tickLine={false} allowDecimals={false} />
          <Tooltip content={renderSectionTooltip} cursor={{ fill: 'rgba(148, 163, 184, 0.12)' }} />
          <Legend iconType="square" iconSize={8} formatter={(v) => <span style={{ fontSize: 11, color: '#64748B' }}>{v}</span>} />
          {sections.map((section, index) => (
            <Bar
              key={section}
              dataKey={section}
              name={section}
              stackId="sections"
              fill={sectionColor(sections, section)}
              maxBarSize={34}
              cursor="pointer"
              onClick={(entry) => openMonth(entry?.payload || entry, section)}
            >
              {index === sections.length - 1 && (
                <LabelList dataKey="total" position="top" style={{ fontSize: 10.5, fontWeight: 600, fill: '#334155' }} />
              )}
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
    )
  }

  function renderCompare() {
    const rowA = months.find((row) => row.monthKey === compareA)
    const rowB = months.find((row) => row.monthKey === compareB)
    if (!rowA || !rowB) return <div className="monthly-trend-empty" style={{ height }}>No dated issues to compare.</div>
    const max = Math.max(1, ...sections.flatMap((section) => [rowA[section], rowB[section]]))
    const change = (a, b) => {
      if (!a) return { text: b ? `+${b.toLocaleString('en-IN')}` : '—', tone: b ? 'up' : '' }
      const pct = Math.round(((b - a) / a) * 100)
      return { text: `${pct > 0 ? '▲' : pct < 0 ? '▼' : ''} ${Math.abs(pct)}%`, tone: pct > 0 ? 'up' : pct < 0 ? 'down' : '' }
    }
    const renderRow = (label, a, b, section) => {
      const delta = change(a, b)
      return (
        <tr key={label} className={section ? '' : 'monthly-compare-total'}>
          <td>{label}</td>
          <td className="monthly-compare-bars">
            {section && (
              <>
                {a > 0 ? (
                  <button type="button" title={`${monthLabel(rowA)} · ${label}: ${a}`} onClick={() => openMonth(rowA, section)}
                    style={{ width: `${(a / max) * 100}%`, background: COMPARE_COLORS.a }} />
                ) : <span className="monthly-compare-bar-empty" />}
                {b > 0 ? (
                  <button type="button" title={`${monthLabel(rowB)} · ${label}: ${b}`} onClick={() => openMonth(rowB, section)}
                    style={{ width: `${(b / max) * 100}%`, background: COMPARE_COLORS.b }} />
                ) : <span className="monthly-compare-bar-empty" />}
              </>
            )}
          </td>
          <td className="monthly-compare-num">{a.toLocaleString('en-IN')}</td>
          <td className="monthly-compare-num">{b.toLocaleString('en-IN')}</td>
          <td className={`monthly-compare-num monthly-compare-change ${delta.tone}`}>{delta.text}</td>
        </tr>
      )
    }
    return (
      <div className="monthly-compare" style={{ maxHeight: height + 30 }}>
        <table>
          <thead>
            <tr>
              <th>Section</th>
              <th />
              <th className="monthly-compare-num"><i style={{ background: COMPARE_COLORS.a }} />{monthLabel(rowA)}</th>
              <th className="monthly-compare-num"><i style={{ background: COMPARE_COLORS.b }} />{monthLabel(rowB)}</th>
              <th className="monthly-compare-num">Change</th>
            </tr>
          </thead>
          <tbody>
            {sections.map((section) => renderRow(section, rowA[section], rowB[section], section))}
            {renderRow('Total', rowA.total, rowB.total)}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <div className="monthly-trend-chart">
      <div className="monthly-trend-toolbar">
        <div className="monthly-trend-views" role="group" aria-label="Monthly trend view">
          {VIEWS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={view === item.key ? 'active' : ''}
              aria-pressed={view === item.key}
              onClick={() => setView(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {view === 'compare' ? (
          <div className="monthly-trend-compare-pickers">
            <select aria-label="First month" value={compareA} onChange={(event) => setCompareA(event.target.value)}>
              {months.map((row) => <option key={row.monthKey} value={row.monthKey}>{monthLabel(row)}</option>)}
            </select>
            <span>vs</span>
            <select aria-label="Second month" value={compareB} onChange={(event) => setCompareB(event.target.value)}>
              {months.map((row) => <option key={row.monthKey} value={row.monthKey}>{monthLabel(row)}</option>)}
            </select>
          </div>
        ) : (
          yearLabel && <div className="monthly-trend-year">{yearLabel}</div>
        )}
      </div>
      {view === 'total' && renderTotal()}
      {view === 'section' && renderBySection()}
      {view === 'compare' && renderCompare()}
    </div>
  )
}
