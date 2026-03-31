import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer
} from 'recharts'
import styles from './FairnessComparisonChart.module.css'

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div className={styles.tooltip}>
      <p className={styles.tooltipLabel}>{label}</p>
      {payload.map(p => (
        <p key={p.dataKey} style={{ color: p.color }}>
          {p.name}: {p.value}%
        </p>
      ))}
    </div>
  )
}

export default function FairnessComparisonChart({ groupMetricsBefore, groupMetricsAfter }) {
  const groups = Object.keys(groupMetricsBefore)
  const data = groups.map(g => ({
    group: g,
    'Before': parseFloat((groupMetricsBefore[g]?.positive_prediction_rate ?? (groupMetricsBefore[g]?.selection_rate * 100) ?? 0).toFixed(1)),
    'After': parseFloat((groupMetricsAfter[g]?.positive_prediction_rate ?? (groupMetricsAfter[g]?.selection_rate * 100) ?? 0).toFixed(1)),
  }))

  return (
    <div className={styles.wrapper}>
      <h4 className={styles.chartTitle}>Positive Prediction Rate by Group</h4>
      <p className={styles.chartDesc}>
        Closer bars = fairer model. After mitigation, rates should be more equal across groups.
      </p>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 5, right: 10, left: -15, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="group" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} />
          <YAxis domain={[0, 100]} tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
            tickFormatter={v => `${v}%`} />
          <Tooltip content={<CustomTooltip />} />
          <Legend wrapperStyle={{ fontSize: '0.78rem', color: 'var(--text-muted)', paddingTop: '8px' }} />
          <Bar dataKey="Before" fill="#f87171" radius={[3,3,0,0]} />
          <Bar dataKey="After" fill="#34d399" radius={[3,3,0,0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
