import {
  Radar, RadarChart as ReRadarChart, PolarGrid,
  PolarAngleAxis, PolarRadiusAxis, Tooltip,
  Legend, ResponsiveContainer
} from 'recharts'
import styles from './RadarChart.module.css'

const COLORS = ['#4f8ef7', '#f87171', '#34d399', '#fbbf24', '#a78bfa', '#fb923c']

// Only 4 metrics — no duplicates
const METRIC_KEYS = [
  { key: 'selection_rate', label: 'Selection Rate' },
  { key: 'accuracy',       label: 'Accuracy' },
  { key: 'tpr',            label: 'TPR' },
  { key: 'precision',      label: 'Precision' },
]

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div className={styles.tooltip}>
      <p className={styles.tooltipTitle}>{label}</p>
      {payload.map(p => (
        <p key={p.dataKey} style={{ color: p.color, fontSize: '0.82rem' }}>
          {p.dataKey}: {(p.value * 100).toFixed(1)}%
        </p>
      ))}
    </div>
  )
}

export default function RadarChart({ groupMetrics, title = 'Per-Group Metrics Radar' }) {
  const groups = Object.keys(groupMetrics)
  if (!groups.length) return null

  // Build data: one entry per metric axis
  const data = METRIC_KEYS.map(({ key, label }) => {
    const entry = { metric: label }
    groups.forEach(g => {
      entry[g] = groupMetrics[g]?.[key] ?? 0
    })
    return entry
  })

  return (
    <div className={styles.wrapper}>
      <h4 className={styles.title}>{title}</h4>
      <ResponsiveContainer width="100%" height={320}>
        <ReRadarChart data={data} cx="50%" cy="50%" outerRadius="65%">
          <PolarGrid stroke="var(--border)" />
          <PolarAngleAxis
            dataKey="metric"
            tick={{ fill: 'var(--text-muted)', fontSize: 12, fontFamily: 'var(--font)' }}
          />
          <PolarRadiusAxis
            angle={90}
            domain={[0, 1]}
            tick={{ fill: 'var(--text-muted)', fontSize: 9 }}
            tickFormatter={v => `${(v * 100).toFixed(0)}%`}
            tickCount={4}
          />
          {groups.map((group, i) => (
            <Radar
              key={group}
              name={group}
              dataKey={group}
              stroke={COLORS[i % COLORS.length]}
              fill={COLORS[i % COLORS.length]}
              fillOpacity={0.18}
              strokeWidth={2}
            />
          ))}
          <Tooltip content={<CustomTooltip />} />
          <Legend
            wrapperStyle={{
              fontSize: '0.82rem',
              color: 'var(--text-muted)',
              paddingTop: '12px',
            }}
          />
        </ReRadarChart>
      </ResponsiveContainer>
    </div>
  )
}
