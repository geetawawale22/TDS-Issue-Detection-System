import { Bar, ComposedChart, Line, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from 'recharts'
import { useSelector } from 'react-redux'
import { selectMonthlyComparison } from '@/redux/slices/issuesSlice'
import './Charts.css'

export default function MonthlyComparisonChart() {
  const data = useSelector(selectMonthlyComparison)

  return (
    <ResponsiveContainer width="100%" height={200}>
      <ComposedChart data={data} margin={{ top: 2, right: 4, left: -20, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
        <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#64748B' }} axisLine={{ stroke: '#E5E7EB' }} tickLine={false} />
        <YAxis yAxisId="left" tick={{ fontSize: 11, fill: '#64748B' }} axisLine={false} tickLine={false} allowDecimals={false} />
        <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11, fill: '#64748B' }} axisLine={false} tickLine={false} unit="%" />
        <Tooltip
          contentStyle={{ borderRadius: 8, border: '1px solid #E5E7EB', fontSize: 12, padding: '6px 10px' }}
          cursor={{ fill: '#F8FAFC' }}
          formatter={(value, name) => (name === '% Change' ? [value == null ? '—' : `${value}%`, name] : [value, name])}
        />
        <Legend iconType="circle" iconSize={8} formatter={(v) => <span style={{ fontSize: 11, color: '#64748B' }}>{v}</span>} />
        <Bar yAxisId="left" dataKey="high" stackId="sev" fill="#E01330" name="High" maxBarSize={26} />
        <Bar yAxisId="left" dataKey="medium" stackId="sev" fill="#F59E0B" name="Medium" maxBarSize={26} />
        <Bar yAxisId="left" dataKey="low" stackId="sev" fill="#94A3B8" name="Low" radius={[4, 4, 0, 0]} maxBarSize={26} />
        <Line yAxisId="right" type="monotone" dataKey="change" stroke="#2563EB" strokeWidth={2} dot={{ r: 3 }} name="% Change" connectNulls />
      </ComposedChart>
    </ResponsiveContainer>
  )
}
