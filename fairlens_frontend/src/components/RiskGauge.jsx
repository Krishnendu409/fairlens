import { useEffect, useState } from 'react'
import styles from './RiskGauge.module.css'

export default function RiskGauge({ score, label }) {
  const [animated, setAnimated] = useState(0)

  useEffect(() => {
    const start = performance.now()
    const duration = 900
    function step(now) {
      const p = Math.min((now - start) / duration, 1)
      const e = 1 - Math.pow(1 - p, 3)
      setAnimated(score * e)
      if (p < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }, [score])

  const color = label === 'Low' ? 'var(--green)' : label === 'Medium' ? 'var(--amber)' : 'var(--red)'
  const bgColor = label === 'Low'
    ? 'rgba(74,222,128,0.12)'
    : label === 'Medium'
    ? 'rgba(251,191,36,0.12)'
    : 'rgba(248,113,113,0.12)'

  // Semicircle arc from 180° to 0° (left to right across top)
  const R = 72
  const cx = 105, cy = 95
  const arcLength = Math.PI * R  // half circumference
  const filled = (animated / 100) * arcLength

  // SVG path for semicircle
  const startX = cx - R, endX = cx + R

  return (
    <div className={styles.wrapper}>
      <svg viewBox="0 0 210 115" className={styles.svg}>
        {/* Background arc */}
        <path
          d={`M ${startX} ${cy} A ${R} ${R} 0 0 1 ${endX} ${cy}`}
          fill="none"
          stroke="var(--border)"
          strokeWidth="13"
          strokeLinecap="round"
        />
        {/* Filled arc */}
        <path
          d={`M ${startX} ${cy} A ${R} ${R} 0 0 1 ${endX} ${cy}`}
          fill="none"
          stroke={color}
          strokeWidth="13"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${arcLength}`}
          style={{ filter: `drop-shadow(0 0 6px ${color})` }}
        />

        {/* Zone labels — ABOVE the arc endpoints, not on the line */}
        {/* Low — bottom-left, below arc start */}
        <text x="18" y="108" className={styles.zoneLabel} fill="var(--green)">Low</text>
        {/* Med — TOP center, clearly above the arc */}
        <text x="105" y="18" textAnchor="middle" className={styles.zoneLabel} fill="var(--amber)">Med</text>
        {/* High — bottom-right */}
        <text x="178" y="108" className={styles.zoneLabel} fill="var(--red)">High</text>

        {/* Score */}
        <text x={cx} y={cy - 12} textAnchor="middle" className={styles.score} fill={color}>
          {Math.round(animated)}
        </text>
        <text x={cx} y={cy + 6} textAnchor="middle" className={styles.outOf} fill="var(--text-muted)">
          / 100
        </text>
      </svg>

      <div className={styles.badge} style={{ background: bgColor, color }}>
        {label} Risk
      </div>
    </div>
  )
}
