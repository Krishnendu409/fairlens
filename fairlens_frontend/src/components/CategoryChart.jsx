import styles from './CategoryChart.module.css'

const COLORS = {
  Gender:       '#a78bfa',
  Race:         '#f87171',
  Age:          '#fbbf24',
  Religion:     '#34d399',
  Socioeconomic:'#4f8ef7',
  Political:    '#fb923c',
}

function getBarColor(score) {
  if (score < 30) return '#34d399'
  if (score < 65) return '#fbbf24'
  return '#f87171'
}

/**
 * Horizontal bar chart showing bias per dimension.
 * categories: [{ name: string, score: number }]
 */
export default function CategoryChart({ categories }) {
  return (
    <div className={styles.wrapper}>
      {categories.map(cat => (
        <div key={cat.name} className={styles.row}>
          <div className={styles.label}>
            <span
              className={styles.dot}
              style={{ background: COLORS[cat.name] || '#8b90b8' }}
            />
            {cat.name}
          </div>
          <div className={styles.barTrack}>
            <div
              className={styles.barFill}
              style={{
                width: `${cat.score}%`,
                background: getBarColor(cat.score),
              }}
            />
          </div>
          <div className={styles.score}>{Math.round(cat.score)}</div>
        </div>
      ))}
    </div>
  )
}
