import { useState } from 'react'
import HighlightedText from './HighlightedText'
import Icon from './Icon'
import styles from './RewritePanel.module.css'

export default function RewritePanel({ original, unbiased, flaggedPhrases }) {
  const [copied, setCopied] = useState(false)
  const originalWords = (original || '').split(/\s+/).filter(Boolean).length
  const unbiasedWords = (unbiased || '').split(/\s+/).filter(Boolean).length
  const delta = unbiasedWords - originalWords

  function copyUnbiased() {
    navigator.clipboard.writeText(unbiased).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className={styles.wrapper}>
      {/* Original with inline highlights */}
      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <span className={styles.badge} style={{ background: 'rgba(248,113,113,0.15)', color: 'var(--red)' }}>
            <Icon name='close' size={13}/> Original Response
          </span>
          {flaggedPhrases?.length > 0 && (
            <span className={styles.flagCount}>
              {flaggedPhrases.length} phrase{flaggedPhrases.length > 1 ? 's' : ''} flagged
            </span>
          )}
        </div>
        <HighlightedText text={original} flaggedPhrases={flaggedPhrases} />
      </div>

      {/* Arrow */}
      <div className={styles.arrow}>→</div>

      {/* Unbiased rewrite */}
      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <span className={styles.badge} style={{ background: 'rgba(52,211,153,0.15)', color: 'var(--green)' }}>
            <Icon name='check' size={13}/> Unbiased Rewrite
          </span>
          <button className={styles.copyBtn} onClick={copyUnbiased}>
            <>{copied ? <Icon name='check' size={12}/> : <Icon name='copy' size={12}/>} {copied ? 'Copied' : 'Copy'}</>
          </button>
        </div>
        <p className={styles.text}>{unbiased}</p>
        <p className={styles.diffMeta}>
          Diff: {delta >= 0 ? `+${delta}` : `${delta}`} words ({originalWords} → {unbiasedWords})
        </p>
      </div>
    </div>
  )
}
