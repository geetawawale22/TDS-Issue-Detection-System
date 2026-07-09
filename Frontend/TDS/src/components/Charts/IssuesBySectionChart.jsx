import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { issuesBySection } from '@/data/mockData'
import './Charts.css'

export default function IssuesBySectionChart() {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={issuesBySection} margin={{ top: 2, right: 4, left: -20, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
        <XAxis dataKey="section" tick={{ fontSize: 11, fill: '#64748B', fontFamily: 'JetBrains Mono' }} axisLine={{ stroke: '#E5E7EB' }} tickLine={false} />
        <YAxis tick={{ fontSize: 11, fill: '#64748B' }} axisLine={false} tickLine={false} />
        <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid #E5E7EB', fontSize: 12, padding: '6px 10px' }} labelStyle={{ fontWeight: 600, color: '#111827' }} cursor={{ fill: '#F8FAFC' }} />
        <Bar dataKey="count" fill="#991B1B" radius={[4, 4, 0, 0]} maxBarSize={28} />
      </BarChart>
    </ResponsiveContainer>
  )
}
