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

export default function IssuesByTypeChart() {
  const data = useSelector(selectIssuesByType)
  const max = Math.max(...data.map((d) => d.count), 1)

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 2, right: 4, left: -20, bottom: 55 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
        <XAxis
          dataKey="type"
          tick={{ fontSize: 9, fill: '#64748B' }}
          axisLine={{ stroke: '#E5E7EB' }}
          tickLine={false}
          interval={0}
          angle={-35}
          textAnchor="end"
          height={70}
        />
        <YAxis tick={{ fontSize: 11, fill: '#64748B' }} axisLine={false} tickLine={false} allowDecimals={false} />
        <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid #E5E7EB', fontSize: 12, padding: '6px 10px' }} cursor={{ fill: '#F8FAFC' }} />
        <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={26}>
          {data.map((row) => (
            <Cell key={row.type} fill={barColor(row.count / max)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
