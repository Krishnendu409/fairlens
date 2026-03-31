import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine
} from 'recharts'
import { getHistory } from '../api/history'
import styles from './TrendChart.module.css'

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  const val = payload[0].value
  const color = val < 30 ? '#34d399' : val < 65 ? '#fbbf24' : '#f87171'
  return (
    <div className={styles.tooltip}>
      <p className={styles.tooltipLabel}>{label}</p>
      <p style={{ color, fontWeight: 700 }}>{val} bias score</p>
    </div>
  )
}

export default function TrendChart() {
  const history = getHistory()
  if (history.length < 2) return null

  // Most recent last for left-to-right time flow
  const data = [...history]
    .reverse()
    .slice(-10)
    .map((entry, i) => ({
      name: `#${i + 1}`,
      score: Math.round(entry.result.bias_score),
      level: entry.result.bias_level,
      prompt: entry.prompt.slice(0, 30) + '...',
    }))

  return (
    <div className={styles.wrapper}>
      <h3 className={styles.title}>Bias Score Trend (Last {data.length} Analyses)</h3>
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={data} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="name" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} />
          <YAxis domain={[0, 100]} tick={{ fill: 'var(--text-muted)', fontSize: 11 }} />
          <Tooltip content={<CustomTooltip />} />
          <ReferenceLine y={30} stroke="#34d399" strokeDasharray="4 4" opacity={0.5} />
          <ReferenceLine y={65} stroke="#fbbf24" strokeDasharray="4 4" opacity={0.5} />
          <Line
            type="monotone"
            dataKey="score"
            stroke="#4f8ef7"
            strokeWidth={2.5}
            dot={{ fill: '#4f8ef7', r: 4, strokeWidth: 0 }}
            activeDot={{ r: 6, fill: '#6ea8fe' }}
          />
        </LineChart>
      </ResponsiveContainer>
      <div className={styles.legend}>
        <span style={{ color: '#34d399' }}>── Low (&lt;30)</span>
        <span style={{ color: '#fbbf24' }}>── Moderate (30–65)</span>
        <span style={{ color: '#f87171' }}>── High (&gt;65)</span>
      </div>
    </div>
  )
}
