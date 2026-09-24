import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useSelector } from 'react-redux'
import { selectIssuesByType } from '@/redux/slices/issuesSlice'
import './Charts.css'

const BAR_DARK = [224, 19, 48]
const BAR_LIGHT = [255, 214, 219]

function barColor(ratio) {
  const [r, g, b] = BAR_DARK.map((c, i) => Math.round(c + (BAR_LIGHT[i] - c) * (1 - ratio)))
  return `rgb(${r}, ${g}, ${b})`
}

const ISSUE_TYPE_LABELS = {
  'LDC Not Yet Valid': 'LDC Date',
  'LDC Expired': 'LDC Date',
  'Wrong TDS Rate': 'Wrong Rate',
  'TDS Deducted as per LDC — Mismatch': 'LDC Mismatch',
  'TDS Deducted as per LDC - Mismatch': 'LDC Mismatch',
  'Short TDS Deducted — Amount Mismatch': 'Short TDS',
  'Short TDS Deducted - Amount Mismatch': 'Short TDS',
  'Excess TDS Deducted — Amount Mismatch': 'Excess TDS',
  'Excess TDS Deducted - Amount Mismatch': 'Excess TDS',
  'Possible Missed TDS Deduction': 'Missed TDS',
  'Wrong Section Applied': 'Wrong Sec',
  'LDC Out of Date': 'LDC Date',
}

function shortIssueType(type) {
  return ISSUE_TYPE_LABELS[type] || String(type || 'Other').replace(/\s+—\s+/g, ' ').slice(0, 14)
}

export default function IssuesByTypeChart({ onBarClick }) {
  const rawData = useSelector(selectIssuesByType)
  const data = rawData.map((row) => ({
    ...row,
    shortType: shortIssueType(row.type),
  }))
  const max = Math.max(...data.map((d) => d.count), 1)

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 2, right: 8, left: -20, bottom: 28 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
        <XAxis
          dataKey="shortType"
          tick={{ fontSize: 10, fill: '#64748B' }}
          axisLine={{ stroke: '#E5E7EB' }}
          tickLine={false}
          interval={0}
          height={34}
        />
        <YAxis tick={{ fontSize: 11, fill: '#64748B' }} axisLine={false} tickLine={false} allowDecimals={false} />
        <Tooltip
          contentStyle={{ borderRadius: 8, border: '1px solid #E5E7EB', fontSize: 12, padding: '6px 10px' }}
          cursor={{ fill: '#F8FAFC' }}
          labelFormatter={(_, payload) => payload?.[0]?.payload?.type || ''}
        />
        <Bar
          dataKey="count"
          radius={[4, 4, 0, 0]}
          maxBarSize={26}
          cursor={onBarClick ? 'pointer' : 'default'}
          onClick={(row) => onBarClick?.(row)}
        >
          {data.map((row) => (
            <Cell key={row.type} fill={barColor(row.count / max)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
