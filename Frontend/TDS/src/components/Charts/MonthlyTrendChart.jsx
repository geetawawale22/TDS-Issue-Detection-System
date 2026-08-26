import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from 'recharts'
import { useDispatch, useSelector } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import { selectMonthlyTrend, setMonthFilter } from '@/redux/slices/issuesSlice'
import './Charts.css'

export default function MonthlyTrendChart() {
  const data = useSelector(selectMonthlyTrend)
  const dispatch = useDispatch()
  const navigate = useNavigate()

  function handleClick(chartState) {
    const month = chartState?.activeLabel
    if (!month) return
    dispatch(setMonthFilter(month))
    navigate('/issues')
  }

  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart
        data={data}
        margin={{ top: 2, right: 4, left: -20, bottom: 0 }}
        onClick={handleClick}
        style={{ cursor: 'pointer' }}
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
        <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid #E5E7EB', fontSize: 12, padding: '6px 10px' }} cursor={{ stroke: '#E5E7EB' }} />
        <Legend iconType="circle" iconSize={8} formatter={(v) => <span style={{ fontSize: 11, color: '#64748B' }}>{v}</span>} />
        <Area type="monotone" dataKey="issues" stroke="#E01330" strokeWidth={2} fill="url(#issueGrad)" dot={false} name="Issues" />
        <Area type="monotone" dataKey="resolved" stroke="#10B981" strokeWidth={2} fill="url(#resolvedGrad)" dot={false} name="Resolved" />
      </AreaChart>
    </ResponsiveContainer>
  )
}
