import styles from './HighlightedText.module.css'

/**
 * Renders text with flagged phrases highlighted inline in red.
 */
export default function HighlightedText({ text, flaggedPhrases }) {
  if (!flaggedPhrases || flaggedPhrases.length === 0) {
    return <p className={styles.text}>{text}</p>
  }

  // Build a regex that matches any flagged phrase (case-insensitive)
  const escaped = flaggedPhrases.map(p =>
    p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  )
  const pattern = new RegExp(`(${escaped.join('|')})`, 'gi')
  const parts = text.split(pattern)

  return (
    <p className={styles.text}>
      {parts.map((part, i) => {
        const isMatch = flaggedPhrases.some(
          phrase => phrase.toLowerCase() === part.toLowerCase()
        )
        return isMatch ? (
          <mark key={i} className={styles.highlight} title="Flagged as biased">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      })}
    </p>
  )
}
