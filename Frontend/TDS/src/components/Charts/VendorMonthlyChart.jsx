import { Line, LineChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from 'recharts'
import { useSelector } from 'react-redux'
import { selectVendorMonthlyTrend } from '@/redux/slices/issuesSlice'
import './Charts.css'

const LINE_COLORS = ['#E01330', '#2563EB', '#F59E0B', '#10B981', '#8B5CF6']

export default function VendorMonthlyChart() {
  const { data, vendors } = useSelector(selectVendorMonthlyTrend)

  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data} margin={{ top: 2, right: 4, left: -20, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
        <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#64748B' }} axisLine={{ stroke: '#E5E7EB' }} tickLine={false} />
        <YAxis tick={{ fontSize: 11, fill: '#64748B' }} axisLine={false} tickLine={false} allowDecimals={false} />
        <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid #E5E7EB', fontSize: 12, padding: '6px 10px' }} cursor={{ stroke: '#E5E7EB' }} />
        <Legend iconType="circle" iconSize={8} formatter={(v) => <span style={{ fontSize: 11, color: '#64748B' }}>{v}</span>} />
        {vendors.map((vendor, idx) => (
          <Line
            key={vendor}
            type="monotone"
            dataKey={vendor}
            stroke={LINE_COLORS[idx % LINE_COLORS.length]}
            strokeWidth={2}
            dot={{ r: 3 }}
            name={vendor}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}
