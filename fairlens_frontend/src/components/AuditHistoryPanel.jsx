import { useState } from 'react'
import Icon from './Icon'
import { getAuditHistory, clearAuditHistory, deleteAuditHistoryItem } from '../api/history'
import styles from './HistoryPanel.module.css'

export default function AuditHistoryPanel({ onOpen, onClose }) {
  const [history, setHistory] = useState(getAuditHistory)

  function handleOpen(entry) { onOpen?.(entry); onClose?.() }
  function handleDelete(id, e) {
    e.stopPropagation()
    deleteAuditHistoryItem(id)
    setHistory(getAuditHistory())
  }
  function handleClear() { clearAuditHistory(); setHistory([]) }

  const levelColor = { Low: '#34d399', Moderate: '#fbbf24', High: '#f97316', Critical: '#f87171' }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.panel} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <h3>Audit History</h3>
          <div className={styles.headerActions}>
            {history.length > 0 && <button className={styles.clearBtn} onClick={handleClear}>Clear all</button>}
            <button className={styles.closeBtn} onClick={onClose} aria-label='Close'><Icon name='close' size={14}/></button>
          </div>
        </div>
        {history.length === 0 ? (
          <div className={styles.empty}><Icon name='chart' size={20}/><p>No audits yet.</p></div>
        ) : (
          <div className={styles.list}>
            {history.map(entry => {
              const r = entry.result || {
                bias_score: entry.bias_score,
                bias_level: entry.bias_level,
                total_rows: entry.total_rows,
                sensitive_column: entry.sensitive_column,
                target_column: entry.target_column,
              }
              const level = r.bias_level || 'Moderate'
              const color = levelColor[level] || '#fbbf24'
              return (
                <div key={entry.id} className={styles.item} onClick={() => handleOpen(entry)}>
                  <div className={styles.itemLeft}>
                    <div className={styles.scoreBadge} style={{
                      background: `${color}22`, color, borderColor: `${color}44`,
                    }}>
                      {Math.round(r.bias_score || 0)}
                    </div>
                    <div className={styles.itemInfo}>
                      <p className={styles.itemPrompt}>
                        {entry.description
                          ? entry.description.slice(0, 55) + (entry.description.length > 55 ? '…' : '')
                          : `${r.sensitive_column || '?'} → ${r.target_column || '?'}`}
                      </p>
                      <span className={styles.itemMeta}>
                        {level} · {r.total_rows} rows · {r.sensitive_column || '?'} ·{' '}
                        {new Date(entry.timestamp).toLocaleDateString()}{' '}
                        {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  </div>
                  <button className={styles.deleteBtn} onClick={e => handleDelete(entry.id, e)}><Icon name='delete' size={13}/></button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
