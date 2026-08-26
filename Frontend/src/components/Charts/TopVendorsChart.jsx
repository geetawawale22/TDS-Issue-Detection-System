import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useSelector } from 'react-redux'
import { selectTopVendors } from '@/redux/slices/issuesSlice'
import './Charts.css'

export default function TopVendorsChart() {
  const data = useSelector(selectTopVendors)

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} layout="vertical" margin={{ top: 2, right: 12, left: 8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#E5E7EB" />
        <XAxis type="number" tick={{ fontSize: 11, fill: '#64748B' }} axisLine={false} tickLine={false} />
        <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#64748B', fontFamily: 'JetBrains Mono' }} axisLine={false} tickLine={false} width={90} />
        <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid #E5E7EB', fontSize: 12, padding: '6px 10px' }} cursor={{ fill: '#F8FAFC' }} />
        <Bar dataKey="issues" fill="#F59E0B" radius={[0, 4, 4, 0]} maxBarSize={18} name="Issues" />
      </BarChart>
    </ResponsiveContainer>
  )
}
