import { useState, useMemo, useEffect } from 'react'
import { getAuditHistory } from '../api/history'
import { getAuditResultById } from '../api/audit'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line, CartesianGrid } from 'recharts'
import Icon from './Icon'
import styles from './VersionCompare.module.css'

export default function VersionCompare({ currentResult }) {
  const history = getAuditHistory()
  const [selectedId, setSelectedId] = useState(history.length > 0 ? history[0].id : null)
  const [resolvedHistory, setResolvedHistory] = useState(history)

  useEffect(() => {
    let active = true
    ;(async () => {
      const hydrated = await Promise.all(history.map(async (h) => {
        if (h.result || !h.audit_id) return h
        try {
          const result = await getAuditResultById(h.audit_id)
          return { ...h, result }
        } catch {
          return h
        }
      }))
      if (active) setResolvedHistory(hydrated)
    })()
    return () => { active = false }
  }, [history])

  const timelineData = useMemo(() => {
    return [...resolvedHistory].reverse().map(h => ({
      date: new Date(h.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      score: h.result?.bias_score || h.bias_score || 0
    }))
  }, [resolvedHistory])

  if (resolvedHistory.length === 0) {
    return <p className={styles.empty}>No past audits found in local history to compare.</p>
  }

  const compareItem = resolvedHistory.find(h => h.id === selectedId) || resolvedHistory[0]
  const oldResult = compareItem.result || {
    bias_score: compareItem.bias_score,
    metrics: [],
  }
  
  if (!oldResult) return null

  const currentScore = currentResult.bias_score || 0
  const oldScore = oldResult.bias_score || 0
  const scoreDiff = currentScore - oldScore

  const metricDiffs = (currentResult.metrics || []).map(cm => {
    const om = (oldResult.metrics || []).find(m => m.key === cm.key)
    const cv = cm.value || 0
    const ov = om ? (om.value || 0) : 0
    const diff = cv - ov
    return { name: cm.name, cv, ov, diff }
  })

  return (
    <div className={styles.compareContainer}>
      <div className={styles.historySidebar}>
        <h3>Audit History</h3>
        <p className={styles.sidebarDesc}>Select a past version to compare.</p>
        <div className={styles.historyList}>
          {resolvedHistory.map(h => (
            <button 
              key={h.id} 
              className={`${styles.historyBtn} ${selectedId === h.id ? styles.active : ''}`}
              onClick={() => setSelectedId(h.id)}
            >
              <div className={styles.histDate}>{new Date(h.timestamp).toLocaleString()}</div>
              <div className={styles.histDesc}>{h.description || 'Unnamed Dataset'}</div>
              <div className={styles.histScore}>Score: {h.result?.bias_score || 0}/100</div>
            </button>
          ))}
        </div>

        {timelineData.length > 1 && (
          <div className={styles.timelineBox}>
            <h4>Bias Trend</h4>
            <div className={styles.timelineChart}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={timelineData}>
                  <Line type="monotone" dataKey="score" stroke="var(--primary)" strokeWidth={2} dot={{ r: 3, fill: 'var(--bg)' }} />
                  <Tooltip contentStyle={{ background: 'var(--surface2)', border: 'none', fontSize: 12, color: 'var(--text)' }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>

      <div className={styles.compareMain}>
        <div className={styles.diffHeader}>
          <div className={styles.diffBox}>
            <span className={styles.diffLabel}>Selected Version</span>
            <strong className={styles.diffValue}>{oldScore}</strong>
          </div>
          <div className={styles.diffArrow}>→</div>
          <div className={styles.diffBox}>
            <span className={styles.diffLabel}>Current Version</span>
            <strong className={styles.diffValue}>{currentScore}</strong>
          </div>
          <div className={`${styles.diffResult} ${scoreDiff > 0 ? styles.diffWorse : scoreDiff < 0 ? styles.diffBetter : ''}`}>
            {scoreDiff > 0 ? '+' : ''}{scoreDiff.toFixed(1)} Pts 
            {scoreDiff === 0 ? ' (No Change)' : scoreDiff < 0 ? ' (Improved)' : ' (Worsened)'}
          </div>
        </div>

        <div className={styles.metricsDiff}>
          <h4>Metric Variances</h4>
          <table className={styles.diffTable}>
            <thead>
              <tr>
                <th>Fairness Metric</th>
                <th>Selected</th>
                <th>Current</th>
                <th>Delta</th>
              </tr>
            </thead>
            <tbody>
              {metricDiffs.map(m => (
                <tr key={m.name}>
                  <td>{m.name}</td>
                  <td>{m.ov.toFixed(4)}</td>
                  <td>{m.cv.toFixed(4)}</td>
                  <td className={m.diff > 0 ? styles.textRed : m.diff < 0 ? styles.textGreen : ''}>
                    {m.diff > 0 ? '+' : ''}{m.diff.toFixed(4)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
