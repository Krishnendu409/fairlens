import Icon from './Icon'
import styles from './ExplanationPanel.module.css'

/**
 * Shows Gemini's plain-language root cause explanation
 * and the flagged phrases that triggered detection.
 */
export default function ExplanationPanel({ explanation, flaggedPhrases }) {
  return (
    <div className={styles.wrapper}>
      <div className={styles.section}>
        <h4 className={styles.sectionTitle}>
          <Icon name='findings' size={14}/> Why this bias exists
        </h4>
        <p className={styles.explanation}>{explanation}</p>
      </div>

      {flaggedPhrases && flaggedPhrases.length > 0 && (
        <div className={styles.section}>
          <h4 className={styles.sectionTitle}>
            <Icon name='warning' size={14}/> Flagged phrases
          </h4>
          <div className={styles.phrases}>
            {flaggedPhrases.map((phrase, i) => (
              <span key={i} className={styles.phrase}>
                &ldquo;{phrase}&rdquo;
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
