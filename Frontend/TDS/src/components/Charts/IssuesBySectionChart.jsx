import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useSelector } from 'react-redux'
import { selectIssuesBySection } from '@/redux/slices/issuesSlice'
import './Charts.css'

export default function IssuesBySectionChart() {
  const data = useSelector(selectIssuesBySection)

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 2, right: 4, left: -20, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
        <XAxis dataKey="section" tick={{ fontSize: 11, fill: '#64748B', fontFamily: 'JetBrains Mono' }} axisLine={{ stroke: '#E5E7EB' }} tickLine={false} />
        <YAxis tick={{ fontSize: 11, fill: '#64748B' }} axisLine={false} tickLine={false} />
        <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid #E5E7EB', fontSize: 12, padding: '6px 10px' }} labelStyle={{ fontWeight: 600, color: '#111827' }} cursor={{ fill: '#F8FAFC' }} />
        <Bar dataKey="count" fill="#E01330" radius={[4, 4, 0, 0]} maxBarSize={28} />
      </BarChart>
    </ResponsiveContainer>
  )
}
