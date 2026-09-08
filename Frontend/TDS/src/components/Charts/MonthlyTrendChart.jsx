import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from 'recharts'
import { useState } from 'react'
import { useSelector } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import { selectMonthlyTrend } from '@/redux/slices/issuesSlice'
import './Charts.css'

export default function MonthlyTrendChart({ onMonthClick }) {
  const data = useSelector(selectMonthlyTrend)
  const navigate = useNavigate()
  const [hoveredIndex, setHoveredIndex] = useState(null)

  function openMonth(point) {
    if (point?.monthKey) {
      if (onMonthClick) onMonthClick(point)
      else navigate(`/issues?view=issue&month=${point.monthKey}`)
    }
  }

  function renderTooltip({ active, payload }) {
    const point = payload?.[0]?.payload
    if (!active || !point) return null
    return (
      <div className="monthly-trend-tooltip">
        <div className="monthly-trend-tooltip-month">{point.month}</div>
        <div className="monthly-trend-tooltip-value monthly-trend-tooltip-value--issues">Issues: {point.issues}</div>
        <div className="monthly-trend-tooltip-value monthly-trend-tooltip-value--resolved">Resolved: {point.resolved}</div>
        <button type="button" className="monthly-trend-tooltip-action" onClick={() => openMonth(point)}>
          Open month issues
        </button>
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={200}>
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
        <Tooltip content={renderTooltip} cursor={{ stroke: '#E5E7EB' }} />
        <Legend iconType="circle" iconSize={8} formatter={(v) => <span style={{ fontSize: 11, color: '#64748B' }}>{v}</span>} />
        <Area type="monotone" dataKey="issues" stroke="#E01330" strokeWidth={2} fill="url(#issueGrad)" name="Issues" dot={false} />
        <Area type="monotone" dataKey="resolved" stroke="#10B981" strokeWidth={2} fill="url(#resolvedGrad)" name="Resolved" dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  )
}
