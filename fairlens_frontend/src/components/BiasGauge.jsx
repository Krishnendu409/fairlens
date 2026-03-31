import { useEffect, useState } from 'react'
import styles from './BiasGauge.module.css'

export default function BiasGauge({ score, level, confidence }) {
  const [animated, setAnimated] = useState(0)
  const radius = 52
  const circumference = 2 * Math.PI * radius

  useEffect(() => {
    const start = performance.now()
    const duration = 1000
    function step(now) {
      const t = Math.min((now - start) / duration, 1)
      const eased = 1 - Math.pow(1 - t, 3)
      setAnimated(score * eased)
      if (t < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }, [score])

  const filled = (animated / 100) * circumference
  const gap    = circumference - filled
  const color  = score < 20 ? 'var(--green)' : score < 45 ? 'var(--amber)' : score < 70 ? '#f97316' : 'var(--red)'
  const label  = level || (score < 20 ? 'Low' : score < 45 ? 'Moderate' : score < 70 ? 'High' : 'Critical')

  return (
    <div className={styles.wrapper}>
      <svg viewBox="0 0 120 120" className={styles.svg}>
        <circle cx="60" cy="60" r={radius + 8} fill="none" stroke={color} strokeWidth="0.5" opacity="0.15"/>
        <circle cx="60" cy="60" r={radius} fill="none" stroke="var(--border)" strokeWidth="9"/>
        <circle
          cx="60" cy="60" r={radius}
          fill="none" stroke={color} strokeWidth="9" strokeLinecap="round"
          strokeDasharray={`${filled} ${gap}`}
          transform="rotate(-90 60 60)"
          style={{ filter: `drop-shadow(0 0 8px ${color}88)`, transition: 'stroke-dasharray 0.05s' }}
        />
        <text x="60" y="56" textAnchor="middle" className={styles.scoreText} fill={color}>
          {Math.round(animated)}
        </text>
        <text x="60" y="68" textAnchor="middle" className={styles.subText} fill="var(--text-muted)">
          / 100
        </text>
        {confidence !== undefined && (
          <text x="60" y="79" textAnchor="middle" className={styles.confText} fill="var(--text-muted)">
            {Math.round(confidence)}% conf.
          </text>
        )}
      </svg>
      <div className={styles.badge} style={{ background: `${color}20`, color, borderColor: `${color}50` }}>
        {label} Bias
      </div>
    </div>
  )
}
