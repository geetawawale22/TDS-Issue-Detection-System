import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { useSelector } from 'react-redux'
import { selectComplianceHealth } from '@/redux/slices/issuesSlice'
import './Charts.css'

export default function ComplianceHealthChart() {
  const data = useSelector(selectComplianceHealth)

  return (
    <ResponsiveContainer width="100%" height={200}>
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          innerRadius={55}
          outerRadius={80}
          paddingAngle={3}
          dataKey="value"
        >
          {data.map((entry, i) => (
            <Cell key={i} fill={entry.color} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={{ borderRadius: 8, border: '1px solid #E5E7EB', fontSize: 12, padding: '6px 10px' }}
          formatter={(v) => [`${v}%`, '']}
        />
        <Legend
          iconType="circle"
          iconSize={8}
          formatter={(v) => <span style={{ fontSize: 11, color: '#64748B' }}>{v}</span>}
        />
      </PieChart>
    </ResponsiveContainer>
  )
}
