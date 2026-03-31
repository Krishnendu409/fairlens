import ThemeToggle from './ThemeToggle'
import styles from './PageHeader.module.css'

/**
 * Unified frosted-glass header used on both Results and AuditResults pages.
 * Props:
 *   onBack        — () => void
 *   actions       — array of { label, icon?, onClick, disabled?, success? }
 */
export default function PageHeader({ onBack, actions = [] }) {
  return (
    <header className={styles.header}>
      <div className={styles.left}>
        <button className={styles.backBtn} onClick={onBack}>← Back</button>
        <img src="/fairlens_logo.png" alt="FairLens" className={styles.logo} />
      </div>
      <div className={styles.right}>
        <ThemeToggle />
        {actions.map((a, i) => (
          <button
            key={i}
            className={`${styles.btn} ${a.success ? styles.btnSuccess : ''}`}
            onClick={a.onClick}
            disabled={a.disabled}
          >
            {a.label}
          </button>
        ))}
      </div>
    </header>
  )
}
