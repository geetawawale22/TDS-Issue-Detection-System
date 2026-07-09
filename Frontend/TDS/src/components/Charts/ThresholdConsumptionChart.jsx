import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, ReferenceLine } from 'recharts'
import { thresholdConsumptionTrend } from '@/data/mockData'
import './Charts.css'

export default function ThresholdConsumptionChart() {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={thresholdConsumptionTrend} margin={{ top: 2, right: 4, left: -20, bottom: 0 }}>
        <defs>
          <linearGradient id="consumptionGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#F59E0B" stopOpacity={0.2} />
            <stop offset="95%" stopColor="#F59E0B" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
        <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#64748B' }} axisLine={{ stroke: '#E5E7EB' }} tickLine={false} />
        <YAxis tick={{ fontSize: 11, fill: '#64748B' }} axisLine={false} tickLine={false} domain={[0, 100]} />
        <ReferenceLine y={75} stroke="#F59E0B" strokeDasharray="4 3" strokeWidth={1.5} label={{ value: '75%', fontSize: 10, fill: '#F59E0B', position: 'right' }} />
        <ReferenceLine y={100} stroke="#EF4444" strokeDasharray="4 3" strokeWidth={1.5} label={{ value: '100%', fontSize: 10, fill: '#EF4444', position: 'right' }} />
        <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid #E5E7EB', fontSize: 12, padding: '6px 10px' }} formatter={(v) => [`${v}%`, 'Consumption']} cursor={{ stroke: '#E5E7EB' }} />
        <Area type="monotone" dataKey="consumption" stroke="#F59E0B" strokeWidth={2} fill="url(#consumptionGrad)" dot={false} name="Consumption" />
      </AreaChart>
    </ResponsiveContainer>
  )
}
