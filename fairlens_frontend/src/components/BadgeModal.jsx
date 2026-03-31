import { useState } from 'react'
import Icon from './Icon'
import styles from './BadgeModal.module.css'

export default function BadgeModal({ result, onClose }) {
  const [copied, setCopied] = useState(false)
  const score = result.bias_score || 0
  const level = result.bias_level || 'Unknown'
  const date = new Date().toLocaleDateString('en-GB')
  
  const color = score < 20 ? '4ade80' : score < 45 ? 'fbbf24' : score < 70 ? 'f97316' : 'f87171'

  // Generate an inline SVG for the badge
  const svgBadge = `<svg xmlns="http://www.w3.org/2000/svg" width="280" height="40" aria-label="FairLens Audit: ${score}/100">
  <linearGradient id="b" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="a"><rect width="280" height="40" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#a)">
    <rect width="160" height="40" fill="#26262a"/>
    <rect x="160" width="120" height="40" fill="#${color}"/>
    <rect width="280" height="40" fill="url(#b)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11" font-weight="bold">
    <text x="80" y="25" fill="#e8720c">FairLens <tspan fill="#f0ece4" font-weight="normal">Audited</tspan></text>
    <text x="220" y="25" fill="#1a1a1a">${score}/100 - ${level}</text>
  </g>
</svg>`

  const b64 = btoa(svgBadge)
  const badgeUrl = `data:image/svg+xml;base64,${b64}`

  const mdCode = `[![FairLens Audit](${badgeUrl})](https://fairlens.ai)`
  const htmlCode = `<a href="https://fairlens.ai"><img src="${badgeUrl}" alt="FairLens Audit: ${score}/100"></a>`

  async function handleCopy(text) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { }
  }

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modalContent} onClick={e => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <h3>Get FairScore Badge</h3>
          <button className={styles.closeBtn} onClick={onClose}><Icon name="close" size={16}/></button>
        </div>
        <div className={styles.modalBody}>
          <p>Embed this badge in your GitHub README, documentation, or compliance portal to prove your AI model's fairness.</p>
          
          <div className={styles.badgePreview}>
            <span className={styles.previewLabel}>Preview</span>
            <img src={badgeUrl} alt="FairLens Badge Preview" />
          </div>

          <div className={styles.codeSection}>
            <div className={styles.codeHeader}>
              <span>Markdown</span>
              <button onClick={() => handleCopy(mdCode)}>{copied ? 'Copied!' : 'Copy'}</button>
            </div>
            <textarea readOnly value={mdCode} rows={2} />
          </div>

          <div className={styles.codeSection}>
            <div className={styles.codeHeader}>
              <span>HTML</span>
              <button onClick={() => handleCopy(htmlCode)}>{copied ? 'Copied!' : 'Copy'}</button>
            </div>
            <textarea readOnly value={htmlCode} rows={3} />
          </div>
        </div>
      </div>
    </div>
  )
}
