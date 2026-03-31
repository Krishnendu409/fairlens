import { useTheme } from '../hooks/useTheme'
import styles from './ThemeToggle.module.css'
import Icon from './Icon'

const OPTIONS = [
  { value: 'system', icon: 'monitor', label: 'System' },
  { value: 'light',  icon: 'sun', label: 'Light'  },
  { value: 'dark',   icon: 'moon', label: 'Dark'   },
]

export default function ThemeToggle() {
  const { theme, setTheme } = useTheme()

  return (
    <div className={styles.toggle}>
      {OPTIONS.map(opt => (
        <button
          key={opt.value}
          className={`${styles.btn} ${theme === opt.value ? styles.active : ''}`}
          onClick={() => setTheme(opt.value)}
          title={opt.label}
        >
          <span className={styles.icon && <Icon name={styles.icon} size={14}/>}>{opt.icon && <Icon name={opt.icon} size={14}/>}</span>
          <span className={styles.label}>{opt.label}</span>
        </button>
      ))}
    </div>
  )
}
