import { useState, useRef, useEffect, useMemo } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { decodeShareData, buildShareUrl } from '../api/share'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, Cell, LabelList, Legend,
} from 'recharts'
import { sendChatMessage } from '../api/audit'
import { exportAuditToPdf, exportAuditToPdfBlob } from '../api/exportPdf'
import BiasGauge from '../components/BiasGauge'
import ThemeToggle from '../components/ThemeToggle'
import Icon from '../components/Icon'
import VersionCompare from '../components/VersionCompare'
import BadgeModal from '../components/BadgeModal'
import styles from './AuditResultsPage.module.css'

// ── Metric Card ───────────────────────────────────────────────────────────────
function MetricCard({ metric, plainLang }) {
  const val = metric.value ?? 0
  const thr = metric.threshold ?? 1
  const scale = Math.max(val, thr) * 1.25 || 1
  const pct = Math.min((val / scale) * 100, 100)
  const threshPos = Math.min((thr / scale) * 100, 100)
  return (
    <div className={`${styles.metricCard} ${metric.flagged ? styles.metricFlagged : styles.metricOk}`}>
      <div className={styles.metricHeader}>
        <span className={styles.metricName} title={metric.key}>{metric.name}</span>
        <span className={`${styles.badge} ${metric.flagged ? styles.badgeRed : styles.badgeGreen}`}>
          {metric.flagged ? 'Flagged' : 'OK'}
        </span>
      </div>
      <div className={styles.metricValue}>
        {metric.key === 'performance_gap'
          ? `${val.toFixed(1)}%`
          : val.toFixed(4)
        }
      </div>
      <div className={styles.metricTrack}>
        <div className={styles.metricFill} style={{ width: `${pct}%`, background: metric.flagged ? 'var(--red)' : 'var(--green)' }}/>
        {metric.threshold != null && (
          <div className={styles.metricThresh} style={{ left: `${threshPos}%` }}/>
        )}
      </div>
      {metric.threshold != null && (
        <div className={styles.metricThreshLabel}>
          Threshold: {metric.threshold_direction === 'above' ? '>=' : '<'}{metric.threshold}
        </div>
      )}
      {metric.interpretation && <p className={styles.metricInterp}>{metric.interpretation}</p>}
      {plainLang && <p className={styles.plainLangMetric}>{plainLang}</p>}
    </div>
  )
}

function toCompactSentence(text, maxLen = 180) {
  if (!text) return ''
  const first = String(text).split('. ')[0]?.trim() || ''
  if (first.length <= maxLen) return first.endsWith('.') ? first : `${first}.`
  return `${first.slice(0, maxLen).trim()}…`
}

// ── Chat Panel ────────────────────────────────────────────────────────────────
function ChatPanel({ datasetDescription, auditSummary }) {
  const [messages, setMessages] = useState([{
    role: 'assistant',
    content: "Audit complete. Ask me anything — why bias exists, what metrics mean, or how to reduce it."
  }])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef(null)
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  async function handleSend() {
    const msg = input.trim()
    if (!msg || loading) return
    setInput('')
    const newMessages = [...messages, { role: 'user', content: msg }]
    setMessages(newMessages)
    setLoading(true)
    try {
      const reply = await sendChatMessage({
        datasetDescription, auditSummary,
        conversation: newMessages.slice(1, -1),
        message: msg,
      })
      setMessages(prev => [...prev, { role: 'assistant', content: reply }])
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Connection error. Please try again.' }])
    } finally { setLoading(false) }
  }

  return (
    <div className={styles.chatPanel}>
      <div className={styles.chatHeader}>
        <div className={styles.chatHeaderLeft}>
          <div className={styles.chatDot}/>
          <span>Ask FairLens AI</span>
        </div>
      </div>
      <div className={styles.chatMessages}>
        {messages.map((m, i) => (
          <div key={i} className={`${styles.chatBubble} ${m.role === 'user' ? styles.chatUser : styles.chatBot}`}>
            {m.role === 'assistant' && <div className={styles.chatAvatar}>FL</div>}
            <div className={styles.chatText}>{m.content}</div>
          </div>
        ))}
        {loading && (
          <div className={`${styles.chatBubble} ${styles.chatBot}`}>
            <div className={styles.chatAvatar}>FL</div>
            <div className={styles.chatTyping}><span/><span/><span/></div>
          </div>
        )}
        <div ref={bottomRef}/>
      </div>
      <div className={styles.chatSuggestions}>
        {['Why does bias exist?', 'What is DPD?', 'How to fix this?', 'Which group is most affected?'].map(s => (
          <button key={s} className={styles.chatSugg} onClick={() => setInput(s)}>{s}</button>
        ))}
      </div>
      <div className={styles.chatInputRow}>
        <input className={styles.chatInput} value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSend()}
          placeholder="Ask about these results..." disabled={loading}/>
        <button className={styles.chatSend} onClick={handleSend} disabled={loading || !input.trim()}>
          <Icon name="send" size={14}/>
        </button>
      </div>
    </div>
  )
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
const TABS = [
  { id: 'summary',      label: 'Summary',       icon: 'overview'  },
  { id: 'diagnosis',    label: 'Why Bias',       icon: 'findings'  },
  { id: 'evidence',     label: 'Evidence',       icon: 'chart'     },
  { id: 'fix',          label: 'Fix Bias',       icon: 'simulation'},
  { id: 'insights',     label: 'AI Insights',    icon: 'insights'  },
  { id: 'whatif',       label: 'What-If',        icon: 'analyse'   },
  { id: 'versions',     label: 'Versions',       icon: 'history'   },
  { id: 'transparency', label: 'Transparency',   icon: 'target'    },
  { id: 'ask',          label: 'Ask AI',         icon: 'chat'      },
]

const normalizeGroup = v => v === null || v === undefined ? '' : String(v)

// ── Counterfactual Editor ─────────────────────────────────────────────────────
// Implements Google WIT-style counterfactual analysis with proper multi-feature
// scoring — not just a group rate lookup.
//
// SCORING METHODOLOGY (inspired by Google's What-If Tool):
//   Google WIT re-runs the actual model. Since we don't have a deployed model,
//   we compute an individual-level LOGISTIC SCORE using:
//     1. A base score from the row's numeric features (z-score → logit → sigmoid)
//     2. A group disparity multiplier from the audit's observed pass rates
//   This gives a meaningful per-individual prediction that accounts for ALL
//   numeric features, not just the group average.
//
// LEGAL BASIS:
//   GDPR Art. 22 + AI Act Art. 86 + CJEU C-203/22 (Dun & Bradstreet Austria):
//   Individuals subject to automated decisions have the right to a counterfactual
//   explanation showing how a change in a single attribute would change the outcome.
//
// CONSTRAINT: Only the sensitive column value is editable (per user requirement).
//   Other features are held constant — this is the pure counterfactual fairness
//   definition: identical in all respects except the protected attribute.

// ── Scoring Engine ────────────────────────────────────────────────────────────
// Computes feature statistics from all sample rows for normalisation
function computeFeatureStats(rows, numericCols) {
  const stats = {}
  for (const col of numericCols) {
    const vals = rows.map(r => Number(r[col])).filter(v => !isNaN(v) && isFinite(v))
    if (vals.length === 0) continue
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length
    const variance = vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length
    const std = Math.sqrt(variance) || 1
    const min = Math.min(...vals)
    const max = Math.max(...vals)
    stats[col] = { mean, std, min, max, range: max - min || 1 }
  }
  return stats
}

// Sigmoid function: maps any real number to [0, 1]
function sigmoid(x) {
  return 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, x))))
}

// Computes per-group feature correlations with the target (pass rate proxy)
// Returns a weight vector: features with higher group mean in high-pass-rate groups get positive weight
function computeFeatureWeights(rows, numericCols, sensitiveCol, groupRatesMap) {
  const normRates = Object.fromEntries(
    Object.entries(groupRatesMap || {}).map(([k, v]) => [String(k), v])
  )
  if (Object.keys(normRates).length < 2) {
    // No group info — equal weights
    return Object.fromEntries(numericCols.map(c => [c, 1]))
  }

  const weights = {}
  for (const col of numericCols) {
    // For each group, compute mean of this feature
    const groupMeans = {}
    for (const [grp, rate] of Object.entries(normRates)) {
      const gRows = rows.filter(r => String(r[sensitiveCol]) === grp)
      const vals = gRows.map(r => Number(r[col])).filter(v => !isNaN(v))
      if (vals.length > 0) groupMeans[grp] = vals.reduce((a, b) => a + b, 0) / vals.length
    }
    // Correlation: do higher group means correlate with higher pass rates?
    const entries = Object.entries(groupMeans).filter(([g]) => normRates[g] != null)
    if (entries.length < 2) { weights[col] = 0.5; continue }
    const rateArr = entries.map(([g]) => normRates[g])
    const meanArr = entries.map(([, m]) => m)
    const rBar = rateArr.reduce((a, b) => a + b, 0) / rateArr.length
    const mBar = meanArr.reduce((a, b) => a + b, 0) / meanArr.length
    const cov = entries.reduce((s, _entry, i) => s + (rateArr[i] - rBar) * (meanArr[i] - mBar), 0)
    const varR = rateArr.reduce((s, r) => s + (r - rBar) ** 2, 0)
    const varM = meanArr.reduce((s, m) => s + (m - mBar) ** 2, 0)
    const corr = (varR > 0 && varM > 0) ? cov / Math.sqrt(varR * varM) : 0
    weights[col] = corr  // range [-1, 1]
  }
  return weights
}

// Main scoring function — returns probability in [0, 1] for a given row + group
// Mirrors the WIT approach of "what would the model predict for this individual"
function scoreIndividual(row, group, numericCols, featureStats, featureWeights, groupRatesMap) {
  const normRates = Object.fromEntries(
    Object.entries(groupRatesMap || {}).map(([k, v]) => [String(k), v])
  )

  // Step 1: Compute individual feature score (z-score weighted sum → logit space)
  let featureLogit = 0
  let weightSum = Math.abs(Object.values(featureWeights).reduce((a, b) => a + Math.abs(b), 0)) || 1

  for (const col of numericCols) {
    const val = Number(row[col])
    const stat = featureStats[col]
    if (isNaN(val) || !stat) continue
    const z = (val - stat.mean) / stat.std        // z-score
    const w = (featureWeights[col] || 0) / weightSum
    featureLogit += z * w * 2.5                   // scale to reasonable logit range
  }

  // Step 2: Group disparity adjustment
  // This is the key counterfactual: same individual features, different group
  const groupRate = normRates[String(group)] ?? 0.5
  const globalMean = Object.values(normRates).reduce((a, b) => a + b, 0) / Math.max(Object.keys(normRates).length, 1)
  // Convert group rate to logit offset relative to global mean
  const groupLogit = Math.log((groupRate + 0.001) / (1 - groupRate + 0.001))
    - Math.log((globalMean + 0.001) / (1 - globalMean + 0.001))

  // Step 3: Combined logit → sigmoid probability
  // Feature contribution: 60% (individual merit), group disparity: 40% (bias signal)
  const totalLogit = featureLogit * 0.6 + groupLogit * 0.4

  return sigmoid(totalLogit)
}

function CounterfactualEditor({ sampleRows, sensitiveCol, groupRatesMap, allNumericGaps }) {
  const [selectedRowIndex, setSelectedRowIndex] = useState(0)
  const [editedValue, setEditedValue] = useState('')
  const [showFeatureDetail, setShowFeatureDetail] = useState(false)

  // Normalize all keys to strings
  const normalizedRates = Object.fromEntries(
    Object.entries(groupRatesMap || {}).map(([k, v]) => [String(k), v])
  )
  const availableGroups = Object.keys(normalizedRates)

  // Detect numeric columns (exclude IDs and the sensitive/target cols)
  const idPatterns = /^(id|index|row|num|no|number|sno|serial|player_id)$/i
  const numericCols = sampleRows && sampleRows.length > 0
    ? Object.keys(sampleRows[0]).filter(k => {
        if (k === sensitiveCol) return false
        if (idPatterns.test(k.trim())) return false
        const vals = sampleRows.map(r => r[k]).filter(v => v != null && v !== '')
        const numVals = vals.map(Number).filter(v => !isNaN(v))
        return numVals.length > vals.length * 0.7  // at least 70% numeric
      })
    : []

  // Compute feature stats and weights once
  const featureStats = useMemo(
    () => computeFeatureStats(sampleRows || [], numericCols),
    [sampleRows, numericCols.join(',')]
  )

  // Safe weight computation with try-catch
  const featureWeights = useMemo(() => {
    try {
      return computeFeatureWeights(sampleRows || [], numericCols, sensitiveCol, normalizedRates)
    } catch { return Object.fromEntries(numericCols.map(c => [c, 0.5])) }
  }, [sampleRows, numericCols.join(','), sensitiveCol, JSON.stringify(normalizedRates)])

  useEffect(() => {
    if (sampleRows && sampleRows.length > 0 && sensitiveCol) {
      const v = String(sampleRows[Math.min(selectedRowIndex, sampleRows.length-1)]?.[sensitiveCol] ?? '')
      setEditedValue(v || availableGroups[0] || '')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRowIndex, sampleRows?.length, sensitiveCol])

  if (!sampleRows || sampleRows.length === 0 || availableGroups.length < 2) {
    return (
      <div className={styles.cfEmptyState}>
        <p>No sample data available for counterfactual analysis.</p>
        <p style={{ fontSize: '12px', marginTop: '8px' }}>Ensure the dataset has a sensitive column with at least 2 groups and numeric feature columns.</p>
      </div>
    )
  }

  const activeRow = sampleRows[Math.min(selectedRowIndex, sampleRows.length - 1)]
  const originalGroup = String(activeRow?.[sensitiveCol] ?? '')

  // Score with original group
  const origScore = scoreIndividual(activeRow, originalGroup, numericCols, featureStats, featureWeights, normalizedRates)
  // Score with counterfactual group
  const cfScore = scoreIndividual(activeRow, editedValue, numericCols, featureStats, featureWeights, normalizedRates)

  const hasChange = editedValue !== originalGroup && editedValue !== ''
  const diff = hasChange ? (cfScore - origScore) * 100 : 0

  // Feature contributions for selected row
  const featureContributions = numericCols.map(col => {
    const val = Number(activeRow[col])
    const stat = featureStats[col]
    if (isNaN(val) || !stat) return null
    const z = (val - stat.mean) / stat.std
    const w = featureWeights[col] || 0
    const contribution = z * w  // positive = favours selection
    return { col, val, z, w, contribution, stat }
  }).filter(Boolean).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))

  const maxRate = Math.max(...availableGroups.map(g => normalizedRates[g] || 0), 0.001)

  const diffClass = !hasChange ? styles.cfDiffNeutral
    : diff > 1 ? styles.cfDiffPositive : diff < -1 ? styles.cfDiffNegative : styles.cfDiffNeutral
  const diffMsg = !hasChange ? 'Same group — select a different group to see the counterfactual'
    : diff > 1 ? `+${diff.toFixed(1)}% — more likely to receive a positive outcome`
    : diff < -1 ? `${diff.toFixed(1)}% — less likely to receive a positive outcome`
    : 'No meaningful difference between these groups for this individual'

  const cols = Object.keys(sampleRows[0])

  return (
    <div>
      {/* EU Legal Context Banner */}
      <div className={styles.cfEuBanner}>
        <span className={styles.cfEuIcon}>⚖️</span>
        <div className={styles.cfEuBannerText}>
          <span className={styles.cfEuBannerTitle}>EU AI Act Art. 86 + GDPR Art. 22 — Individual Counterfactual Explanations (CJEU C-203/22)</span>
          <span className={styles.cfEuBannerDesc}>
            The CJEU (C-203/22, Dun &amp; Bradstreet Austria, 2024) confirmed a right to counterfactual explanations of automated decisions.
            This tool holds all {numericCols.length > 0 ? `${numericCols.length} numeric features` : 'features'} constant and changes only <strong>{sensitiveCol}</strong> —
            the pure counterfactual fairness definition. Scores combine individual feature values ({numericCols.length > 0 ? 'weighted by their correlation with the outcome' : 'no numeric features detected'}) with the observed group disparity — not just a group average lookup.
          </span>
        </div>
      </div>

      {/* Group Rate Overview */}
      <div className={styles.card}>
        <h3 className={styles.cardTitle}>Group Selection Rates — Observed Disparity (Bias Evidence)</h3>
        <p className={styles.cardHint}>These group rates drive the counterfactual adjustment. The bar shows each group's historical selection rate from the dataset.</p>
        <div className={styles.cfGroupBar}>
          {availableGroups.map(g => {
            const rate = normalizedRates[g] ?? 0
            const pct = Math.round(rate * 100)
            const fillPct = (rate / maxRate) * 100
            const isMax = rate === maxRate
            const isMin = rate === Math.min(...availableGroups.map(x => normalizedRates[x] ?? 0))
            const color = isMax ? 'var(--green)' : isMin ? 'var(--red)' : 'var(--primary)'
            return (
              <div key={g} className={styles.cfGroupBarItem}>
                <span className={styles.cfGroupBarLabel}>{g}</span>
                <div className={styles.cfGroupBarTrack}>
                  <div className={styles.cfGroupBarFill} style={{ width: `${fillPct}%`, background: color }} />
                </div>
                <span className={styles.cfGroupBarPct} style={{ color }}>{pct}%</span>
              </div>
            )
          })}
        </div>
      </div>

      <div className={styles.cfLayout}>
        {/* Left: Record Table */}
        <div className={styles.cfTableCard}>
          <div className={styles.cfTableHeader}>
            <span>Sample Records — Click to Select Individual</span>
            <span className={styles.cfTableMeta}>{sampleRows.length} records · <strong style={{color:'var(--primary)'}}>{sensitiveCol}</strong> is protected (S) · {numericCols.length} numeric features used in scoring</span>
          </div>
          <div className={styles.cfTableScroll}>
            <table className={styles.cfTable}>
              <thead>
                <tr>
                  <th>#</th>
                  {cols.slice(0, 7).map(k => (
                    <th key={k} style={k === sensitiveCol ? {color:'var(--primary)',fontWeight:800} : {}}>
                      {k}{k === sensitiveCol ? ' (S)' : numericCols.includes(k) ? ' *' : ''}
                    </th>
                  ))}
                  <th style={{color:'var(--primary)',borderLeft:'1px solid var(--border)'}}>Score ▾</th>
                </tr>
              </thead>
              <tbody>
                {sampleRows.map((row, i) => {
                  const rowScore = scoreIndividual(row, String(row[sensitiveCol] ?? ''), numericCols, featureStats, featureWeights, normalizedRates)
                  return (
                    <tr key={i}
                      className={selectedRowIndex === i ? styles.cfActiveRow : ''}
                      onClick={() => setSelectedRowIndex(i)}
                      style={{ cursor: 'pointer' }}>
                      <td style={{color:'var(--text-muted)',fontWeight:600}}>{i+1}</td>
                      {cols.slice(0, 7).map(k => (
                        <td key={k} style={k === sensitiveCol ? {fontWeight:700,color:'var(--primary)'} : {}}>
                          {row[k] != null ? String(row[k]) : '—'}
                        </td>
                      ))}
                      <td style={{fontWeight:700,color:rowScore>0.5?'var(--green)':'var(--red)',fontSize:'11px'}}>
                        {(rowScore*100).toFixed(0)}%
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {numericCols.length > 0 && <p style={{fontSize:'10px',color:'var(--text-muted)',padding:'6px 12px',margin:0}}>* = numeric feature used in individual scoring</p>}
          </div>
        </div>

        {/* Right: Editor */}
        <div className={styles.cfEditorCard}>
          <div className={styles.cfEditorHeader}>
            <Icon name="simulation" size={14} />
            <span className={styles.cfEditorTitle}>Counterfactual Editor · Row {selectedRowIndex + 1}</span>
          </div>
          <div className={styles.cfEditorBody}>
            {/* Row snapshot */}
            <div>
              <p style={{fontSize:'11px',fontWeight:600,color:'var(--text-muted)',marginBottom:'6px',textTransform:'uppercase',letterSpacing:'0.05em'}}>Selected Record</p>
              <div className={styles.cfRowPreview}>
                <div className={styles.cfRowPreviewGrid}>
                  {cols.slice(0, 8).map(k => (
                    <div key={k} className={styles.cfRowPreviewItem}>
                      <span className={styles.cfRowPreviewKey}>{k}:</span>
                      <span className={styles.cfRowPreviewVal}
                        style={k === sensitiveCol ? {color:'var(--primary)',fontWeight:700} : {}}>
                        {activeRow[k] != null ? String(activeRow[k]) : '—'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Group selector */}
            <div className={styles.cfSelectSection}>
              <span className={styles.cfSelectLabel}>
                Change <em style={{color:'var(--primary)'}}>{sensitiveCol}</em> to…
              </span>
              <span className={styles.cfSelectDesc}>
                Original: <strong>{originalGroup}</strong>. Select a counterfactual group. All other {numericCols.length} feature values remain constant (pure counterfactual fairness).
              </span>
              <select className={styles.cfSelect} value={editedValue} onChange={e => setEditedValue(e.target.value)}>
                {availableGroups.map(g => (
                  <option key={g} value={g}>{g}{g === originalGroup ? ' (current)' : ''}</option>
                ))}
              </select>
            </div>

            {/* Outcome comparison */}
            <div>
              <p style={{fontSize:'11px',fontWeight:600,color:'var(--text-muted)',marginBottom:'8px',textTransform:'uppercase',letterSpacing:'0.05em'}}>
                Individual Predicted Outcome Likelihood
                <span style={{fontWeight:400,color:'var(--text-muted)',fontSize:'10px',display:'block',textTransform:'none',letterSpacing:0,marginTop:'2px'}}>
                  Combines individual feature values + group disparity signal
                </span>
              </p>
              <div className={styles.cfComparisonGrid}>
                <div className={styles.cfRateCardOrig}>
                  <span className={styles.cfRateLabel}>Original</span>
                  <span className={styles.cfRateGroup}>{originalGroup}</span>
                  <span className={styles.cfRateNum}>{(origScore * 100).toFixed(1)}%</span>
                  <div className={styles.cfRateBar}>
                    <div className={styles.cfRateFill} style={{width:`${origScore*100}%`,background:'var(--text-muted)'}}/>
                  </div>
                </div>
                <div className={styles.cfArrowBig}>→</div>
                <div className={styles.cfRateCardNew}
                  style={{borderColor: hasChange ? (diff > 1 ? 'rgba(74,222,128,0.4)' : diff < -1 ? 'rgba(248,113,113,0.4)' : 'var(--border)') : 'var(--border)'}}>
                  <span className={styles.cfRateLabel}>Counterfactual</span>
                  <span className={styles.cfRateGroup}
                    style={{background: hasChange ? (diff > 1 ? 'rgba(74,222,128,0.12)' : diff < -1 ? 'rgba(248,113,113,0.12)' : 'var(--surface2)') : 'var(--surface2)'}}>
                    {editedValue || originalGroup}
                  </span>
                  <span className={styles.cfRateNum}
                    style={{color: !hasChange ? 'var(--text)' : diff > 1 ? 'var(--green)' : diff < -1 ? 'var(--red)' : 'var(--text)'}}>
                    {(cfScore * 100).toFixed(1)}%
                  </span>
                  <div className={styles.cfRateBar}>
                    <div className={styles.cfRateFill}
                      style={{width:`${cfScore*100}%`,background: diff > 1 ? 'var(--green)' : diff < -1 ? 'var(--red)' : 'var(--primary)'}}/>
                  </div>
                </div>
              </div>
            </div>

            {/* Diff card */}
            <div className={`${styles.cfDiffCard} ${diffClass}`}>
              <div>{diffMsg}</div>
              {hasChange && Math.abs(diff) > 1 && (
                <div className={styles.cfDiffSubtext}>
                  This {diff > 0 ? 'advantage' : 'disadvantage'} is driven by group membership — holding all {numericCols.length} feature values constant.
                </div>
              )}
            </div>

            {/* Feature Contributions */}
            {numericCols.length > 0 && featureContributions.length > 0 && (
              <div>
                <button
                  onClick={() => setShowFeatureDetail(x => !x)}
                  style={{fontSize:'11px',color:'var(--primary)',fontWeight:600,background:'none',border:'none',cursor:'pointer',padding:'0',textAlign:'left'}}>
                  {showFeatureDetail ? '▼' : '▶'} Feature contributions for this individual ({featureContributions.length} features)
                </button>
                {showFeatureDetail && (
                  <div style={{marginTop:'8px',display:'flex',flexDirection:'column',gap:'4px'}}>
                    {featureContributions.slice(0, 8).map(fc => {
                      const absMax = Math.max(...featureContributions.map(x => Math.abs(x.contribution)), 0.001)
                      const barW = Math.min(Math.abs(fc.contribution) / absMax * 100, 100)
                      const isPos = fc.contribution > 0
                      return (
                        <div key={fc.col} style={{display:'flex',alignItems:'center',gap:'6px',fontSize:'11px'}}>
                          <span style={{width:'100px',color:'var(--text)',fontWeight:500,flexShrink:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{fc.col}</span>
                          <span style={{width:'42px',textAlign:'right',color:'var(--text-muted)',flexShrink:0}}>{fc.val.toFixed(1)}</span>
                          <div style={{flex:1,height:'6px',background:'var(--border)',borderRadius:'3px',overflow:'hidden'}}>
                            <div style={{height:'100%',width:`${barW}%`,background:isPos?'var(--green)':'var(--red)',borderRadius:'3px',marginLeft:isPos?'0':'auto'}}/>
                          </div>
                          <span style={{width:'40px',color:isPos?'var(--green)':'var(--red)',fontWeight:600,textAlign:'right',flexShrink:0}}>
                            {isPos?'+':''}{(fc.contribution*100).toFixed(0)}
                          </span>
                        </div>
                      )
                    })}
                    <p style={{fontSize:'10px',color:'var(--text-muted)',margin:'4px 0 0'}}>
                      Bar width = feature importance × z-score for this individual. Green = favours selection. Values weighted by correlation with outcome across groups.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* EU legal note */}
            <div className={styles.cfLegalNote}>
              <strong>GDPR Art. 22 &amp; AI Act Art. 86 (CJEU C-203/22):</strong> This individual has the right to receive this counterfactual explanation on request.
              The {Math.abs(diff).toFixed(1)}% {diff !== 0 && hasChange ? (diff > 0 ? 'advantage' : 'disadvantage') : 'difference'} shown above
              {Math.abs(diff) > 5 ? ' may constitute evidence of indirect discrimination under EU Charter Art. 21.' : ' is within acceptable tolerance under current EU guidance.'}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function AuditResultsPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState('summary')
  const [shareState, setShareState] = useState('idle')
  const [exporting, setExporting] = useState(false)
  const [previewingPdf, setPreviewingPdf] = useState(false)
  const [pdfPreviewError, setPdfPreviewError] = useState('')
  const [showBadgeModal, setShowBadgeModal] = useState(false)
  const [searchParams] = useSearchParams()
  const [showComplianceMetadataForm, setShowComplianceMetadataForm] = useState(false)
  const [complianceDraft, setComplianceDraft] = useState({})

  let result, datasetDescription
  if (location.state?.result) {
    result = location.state.result; datasetDescription = location.state.description || ''
  } else if (searchParams.get('shared')) {
    const decoded = decodeShareData(searchParams.get('shared'))
    if (decoded?.result) { result = decoded.result; datasetDescription = decoded.description || '' }
  } else {
    try {
      const saved = sessionStorage.getItem('auditResult')
      if (saved) { const p = JSON.parse(saved); result = p.result; datasetDescription = p.description || '' }
    } catch {}
  }

  useEffect(() => {
    if (result) {
      try { sessionStorage.setItem('auditResult', JSON.stringify({ result, description: datasetDescription })) } catch {}
    }
  }, [result, datasetDescription])

  useEffect(() => {
    setComplianceDraft(result?.compliance_metadata || {})
  }, [result])

  if (!result) return (
    <div className={styles.noResult}>
      <p>No audit data found.</p>
      <button className={styles.backBtn} onClick={() => navigate('/')}>← Back to Home</button>
    </div>
  )

  const {
    bias_score, bias_level, risk_label,
    total_rows, columns, sensitive_column, target_column, prediction_column, has_predictions,
    metrics = [], group_stats = [],
    bias_origin, root_causes = [],
    mitigation, statistical_test,
    reliability,
    summary, key_findings = [], recommendations = [],
    audit_summary_json,
    score_breakdown,
    all_numeric_gaps = [],
    primary_numeric_column,
    plain_language = {},
    sample_rows = [],
    group_rates_map = {},
    compliance = {},
  } = result

  const scoreColor = bias_score < 20 ? '#4ade80' : bias_score < 45 ? '#fbbf24' : bias_score < 70 ? '#f97316' : '#f87171'
  const flaggedMetrics = metrics.filter(m => m.flagged)
  const reliabilityData = reliability || { reliability: 'Unknown', confidence_score: null, warnings: [] }
  const reliabilityColor = reliabilityData.reliability === 'High' ? 'var(--green)' : reliabilityData.reliability === 'Medium' ? 'var(--amber)' : reliabilityData.reliability === 'Unknown' ? 'var(--text-muted)' : 'var(--red)'

  const maxRate = group_stats.length > 0 ? Math.max(...group_stats.map(g => g.pass_rate)) : 1
  const minRate = group_stats.length > 0 ? Math.min(...group_stats.map(g => g.pass_rate)) : 0

  const groupChartData = group_stats.map(g => ({
    name: g.group,
    'Pass Rate (%)': Math.round(g.pass_rate * 100),
    fill: g.pass_rate === maxRate ? 'var(--green)' : g.pass_rate === minRate ? 'var(--red)' : 'var(--primary)',
  }))

  const hasEO = has_predictions && group_stats.some(g => g.tpr != null)
  const eoChartData = hasEO ? group_stats.map(g => ({
    name: g.group,
    'TPR (%)': g.tpr != null ? Math.round(g.tpr * 100) : null,
    'FPR (%)': g.fpr != null ? Math.round(g.fpr * 100) : null,
  })).filter(d => d['TPR (%)'] !== null) : []

  const mitigationChartData = mitigation ? [
    { name: 'Before', score: mitigation.bias_before, fill: 'var(--red)' },
    ...(mitigation.results || []).map(r => ({
      name: r.method === 'rate_equalisation' ? 'Rate Equalisation' : r.method.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
      score: r.bias_score,
      fill: r.method === mitigation.best_method ? 'var(--green)' : 'var(--primary)',
      accuracy: r.accuracy,
      improvement: r.improvement,
      isBest: r.method === mitigation.best_method,
    }))
  ] : []

  const tt = {
    contentStyle: { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 },
    labelStyle: { color: 'var(--text)' },
  }

  async function handleShare() {
    try {
      await navigator.clipboard.writeText(buildShareUrl({ result, description: datasetDescription }))
      setShareState('copied'); setTimeout(() => setShareState('idle'), 2000)
    } catch { setShareState('idle') }
  }

  async function handleExport() {
    setShowComplianceMetadataForm(true)
  }

  async function handleConfirmExport() {
    setExporting(true)
    try {
      const payload = { ...result, compliance_metadata: { ...(result?.compliance_metadata || {}), ...complianceDraft } }
      await exportAuditToPdf(payload, datasetDescription)
      setShowComplianceMetadataForm(false)
    } finally { setExporting(false) }
  }

  async function handlePreviewPdf() {
    setPreviewingPdf(true)
    setPdfPreviewError('')
    try {
      const payload = { ...result, compliance_metadata: { ...(result?.compliance_metadata || {}), ...complianceDraft } }
      const blob = await exportAuditToPdfBlob(payload, datasetDescription)
      const nextUrl = URL.createObjectURL(blob)
      const previewTab = window.open(nextUrl, '_blank', 'noopener,noreferrer')
      if (!previewTab) {
        URL.revokeObjectURL(nextUrl)
        throw new Error('Popup blocked')
      }
      setTimeout(() => URL.revokeObjectURL(nextUrl), 60_000)
    } catch (error) {
      console.error('PDF preview failed:', error)
      if (String(error?.message || '').toLowerCase().includes('popup blocked')) {
        setPdfPreviewError('Preview failed because popup was blocked. Allow popups and try again.')
      } else if (String(error?.message || '').toLowerCase().includes('invalid audit result payload')) {
        setPdfPreviewError('Preview failed due to invalid audit data payload.')
      } else {
        setPdfPreviewError(`Preview failed: ${error?.message || 'unknown error'}`)
      }
    } finally {
      setPreviewingPdf(false)
    }
  }

  const tabBadges = {
    diagnosis: root_causes.filter(c => !c.includes('No significant')).length,
    evidence: flaggedMetrics.length,
  }

  return (
    <div className={styles.page}>

      {/* ── Header — frosted glass, same as Results ── */}
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <button className={styles.backBtn} onClick={() => navigate('/')}>
            <Icon name="back" size={13}/> Back
          </button>
          <img src="/fairlens_logo.png" alt="FairLens" className={styles.logoImg}/>
        </div>
        <div className={styles.headerRight}>
          <ThemeToggle/>
          <button className={styles.actionBtn} onClick={() => setShowBadgeModal(true)}>
            <Icon name="check" size={13}/> Get Badge
          </button>
          <button className={styles.actionBtn} onClick={handleShare}>
            {shareState === 'copied'
              ? <><Icon name="check" size={13}/> Copied!</>
              : <><Icon name="share" size={13}/> Share</>}
          </button>
          <button className={styles.actionBtn} onClick={handleExport} disabled={exporting}>
            <Icon name="pdf" size={13}/> {exporting ? 'Generating...' : 'EU Compliance Report'}
          </button>
          <button className={styles.actionBtn} onClick={handlePreviewPdf} disabled={previewingPdf}>
            <Icon name="chart" size={13}/> {previewingPdf ? 'Generating PDF...' : 'Preview PDF'}
          </button>
        </div>
      </header>

      {/* ── Tab Bar ── */}
      <div className={styles.tabBar}>
        {TABS.map(t => (
          <button key={t.id}
            className={`${styles.tab} ${activeTab === t.id ? styles.tabActive : ''} ${t.id === 'ask' ? styles.tabAsk : ''}`}
            onClick={() => setActiveTab(t.id)}>
            <Icon name={t.icon} size={13}/>
            <span className={styles.tabLabel}>{t.label}</span>
            {tabBadges[t.id] > 0 && <span className={styles.tabBadge}>{tabBadges[t.id]}</span>}
          </button>
        ))}
      </div>

      {/* ── Tab Content ── */}
      <div className={styles.main}>
        {pdfPreviewError && (
          <div className={styles.card}>
            <h3 className={styles.sectionTitle} style={{ color: 'var(--red)' }}>{pdfPreviewError}</h3>
          </div>
        )}
        {showComplianceMetadataForm && (
          <div className={styles.card}>
            <h3 className={styles.sectionTitle}>Compliance Metadata (for report only)</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
              {[
                ['dataset_name', 'Dataset name'],
                ['dataset_version', 'Dataset version'],
                ['data_source', 'Data source'],
                ['lawful_basis', 'Lawful basis'],
                ['purpose_of_processing', 'Purpose of processing'],
                ['dpia_status', 'DPIA status'],
                ['oversight_contact', 'Human oversight contact'],
                ['security_assessment_status', 'Security assessment'],
                ['monitoring_frequency', 'Monitoring frequency'],
                ['intended_use', 'Intended use'],
                ['system_limitations', 'System limitations'],
                ['log_retention_policy', 'Log retention policy'],
              ].map(([key, label]) => (
                <label key={key} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                  <span>{label}</span>
                  <input
                    value={complianceDraft?.[key] || ''}
                    onChange={(e) => setComplianceDraft((prev) => ({ ...prev, [key]: e.target.value }))}
                    placeholder="NOT PROVIDED"
                    style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
                  />
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
              <button className={styles.actionBtn} onClick={() => setShowComplianceMetadataForm(false)} disabled={exporting}>
                Cancel
              </button>
              <button className={styles.actionBtn} onClick={handleConfirmExport} disabled={exporting}>
                <Icon name="pdf" size={13}/> {exporting ? 'Generating...' : 'Generate EU Compliance Report'}
              </button>
            </div>
          </div>
        )}

        {/* ══ SUMMARY ══ */}
        {activeTab === 'summary' && (
          <div className={styles.tabContent}>
            <div className={styles.summaryHero}>
              <div className={styles.gaugeWrap}>
                <BiasGauge score={bias_score} level={bias_level} confidence={reliabilityData.confidence_score}/>
              </div>
              <div className={styles.summaryHeroInfo}>
                <div className={styles.riskBadge} style={{ background: scoreColor + '22', color: scoreColor, borderColor: scoreColor + '55' }}>
                  {risk_label}
                </div>
                <h1 className={styles.summaryTitle}>{bias_level} Bias Detected</h1>
                <p className={styles.summaryMeta}>
                  {total_rows?.toLocaleString()} rows · {columns?.length} columns ·
                  Sensitive: <strong>{sensitive_column || 'auto-detected'}</strong> ·
                  Target: <strong>{target_column || 'auto-detected'}</strong>
                  {has_predictions && <> · Prediction: <strong>{prediction_column}</strong></>}
                </p>
                <div className={styles.summaryParas}>
                  {summary.split('\n\n').map((p, i) => <p key={i} className={styles.summaryPara}>{p}</p>)}
                </div>
              </div>
            </div>

            {/* Plain-Language Summary */}
            {plain_language.overall && (
              <div className={styles.plainLangCard}>
                <div className={styles.plainLangHeader}>
                  <Icon name="insights" size={16}/>
                  <span>In Plain English</span>
                </div>
                <p className={styles.plainLangText}>{plain_language.overall}</p>
                {plain_language.demographic_parity_difference && (
                  <p className={styles.plainLangText}>{plain_language.demographic_parity_difference}</p>
                )}
                {plain_language.disparate_impact_ratio && (
                  <p className={styles.plainLangText}>{plain_language.disparate_impact_ratio}</p>
                )}
                {plain_language.statistical_test && (
                  <p className={styles.plainLangText} style={{opacity: 0.85, fontStyle: 'italic'}}>{plain_language.statistical_test}</p>
                )}
              </div>
            )}

            <div className={styles.quickStats}>
              {bias_origin && (
                <div className={styles.statCard} style={{ borderColor: 'var(--red)' + '44' }}>
                  <Icon name="origin" size={20}/>
                  <div>
                    <p className={styles.statLabel}>Most Affected Group</p>
                    <p className={styles.statValue} style={{ color: 'var(--red)' }}>{bias_origin.group}</p>
                    <p className={styles.statMeta}>via {bias_origin.metric}</p>
                  </div>
                </div>
              )}
              {reliabilityData.reliability !== 'Unknown' && (
                <div className={styles.statCard} style={{ borderColor: reliabilityColor + '44' }}>
                  <Icon name="target" size={20}/>
                  <div>
                    <p className={styles.statLabel}>Data Reliability</p>
                    <p className={styles.statValue} style={{ color: reliabilityColor }}>{reliabilityData.reliability}</p>
                    <p className={styles.statMeta}>{reliabilityData.confidence_score ?? '—'}/100 confidence</p>
                  </div>
                </div>
              )}
              <div className={styles.statCard} style={{ borderColor: (flaggedMetrics.length > 0 ? 'var(--red)' : 'var(--green)') + '44' }}>
                <Icon name="metrics" size={20}/>
                <div>
                  <p className={styles.statLabel}>Metrics Flagged</p>
                  <p className={styles.statValue} style={{ color: flaggedMetrics.length > 0 ? 'var(--red)' : 'var(--green)' }}>
                    {flaggedMetrics.length} / {metrics.length}
                  </p>
                  <p className={styles.statMeta}>{flaggedMetrics.length === 0 ? 'All passing' : 'Need attention'}</p>
                </div>
              </div>
              <div className={styles.statCard}>
                <Icon name="groups" size={20}/>
                <div>
                  <p className={styles.statLabel}>Groups Analyzed</p>
                  <p className={styles.statValue}>{group_stats.length}</p>
                  <p className={styles.statMeta}>{group_stats.map(g => g.group).join(', ')}</p>
                </div>
              </div>
            </div>

            <div className={styles.nextStepRow}>
              <button className={styles.nextStepBtn} onClick={() => setActiveTab('diagnosis')}>
                <Icon name="findings" size={14}/> See why bias exists
              </button>
              <button className={styles.nextStepBtnSecondary} onClick={() => setActiveTab('fix')}>
                <Icon name="simulation" size={14}/> Simulate a fix
              </button>
            </div>
          </div>
        )}

        {/* ══ WHY BIAS ══ */}
        {activeTab === 'diagnosis' && (
          <div className={styles.tabContent}>
            <h2 className={styles.tabTitle}>Why Bias Exists</h2>
            <p className={styles.tabSubtitle}>Computed entirely in Python — no AI guessing.</p>

            <div className={styles.card}>
              <h3 className={styles.cardTitle}>Root Causes</h3>
              {root_causes.length > 0 ? (
                <ul className={styles.causeList}>
                  {root_causes.map((c, i) => (
                    <li key={i} className={styles.causeItem}><span className={styles.causeDot}/>{c}</li>
                  ))}
                </ul>
              ) : (
                <p className={styles.muted}>No significant root causes detected.</p>
              )}
            </div>

            {statistical_test && (
              <div className={`${styles.statSigCard} ${statistical_test.is_significant ? styles.statSigFlagged : styles.statSigOk}`}>
                <Icon name={statistical_test.is_significant ? 'warning' : 'check'} size={16}/>
                <div>
                  <p className={styles.statSigTitle}>
                    {statistical_test.is_significant ? 'Statistically Significant Bias' : 'Not Statistically Significant'}
                    {statistical_test.cramers_v != null && (
                      <span className={styles.effectBadge} style={{
                        color: statistical_test.cramers_v >= 0.40 ? 'var(--red)' :
                               statistical_test.cramers_v >= 0.20 ? 'var(--amber)' : 'var(--text-muted)'
                      }}>
                        {' '}· Cramér's V = {statistical_test.cramers_v?.toFixed(3)} ({statistical_test.effect_size} effect)
                      </span>
                    )}
                  </p>
                  <p className={styles.statSigText}>{statistical_test.interpretation}</p>
                </div>
              </div>
            )}

            <h3 className={styles.subTitle}>Key Metrics</h3>
            <div className={styles.metricsGrid}>
              {[
                ...metrics.filter(m => ['demographic_parity_difference', 'disparate_impact_ratio'].includes(m.key)),
                ...(statistical_test ? [{
                  name: 'Chi-square Statistic (χ²)',
                  key: 'chi_square_statistic',
                  value: statistical_test.statistic ?? 0,
                  threshold: null,
                  threshold_direction: 'below',
                  flagged: Boolean(statistical_test.is_significant),
                  interpretation: `p-value=${(statistical_test.p_value ?? 1).toFixed(6)} · ${statistical_test.is_significant ? 'Significant association detected.' : 'No significant association detected.'}`,
                }] : []),
              ].map(m => (
                <MetricCard key={m.key} metric={m} plainLang={plain_language[m.key]}/>
              ))}
            </div>

            <div className={styles.card}>
              <h3 className={styles.cardTitle}>Methods & Research Basis</h3>
              <ul className={styles.causeList}>
                <li className={styles.causeItem}><span className={styles.causeDot}/>DPD and DIR are computed from observed per-group selection rates used in fairness literature and compliance practice.</li>
                <li className={styles.causeItem}><span className={styles.causeDot}/>Chi-square and p-value are computed with scipy&apos;s Pearson chi-square test of independence on the sensitive×target contingency table.</li>
                <li className={styles.causeItem}><span className={styles.causeDot}/>Effect size is reported with Cramér&apos;s V, a standard association-strength statistic for categorical variables.</li>
                <li className={styles.causeItem}><span className={styles.causeDot}/>Narrative text may be AI-assisted, but numeric metrics and flags come from deterministic backend computation.</li>
              </ul>
            </div>

            <div className={styles.nextStepRow}>
              <button className={styles.nextStepBtn} onClick={() => setActiveTab('evidence')}>
                <Icon name="chart" size={14}/> See the evidence
              </button>
            </div>
          </div>
        )}

        {/* ══ EVIDENCE ══ */}
        {activeTab === 'evidence' && (
          <div className={styles.tabContent}>
            <h2 className={styles.tabTitle}>Evidence</h2>
            {has_predictions
              ? <span className={styles.modeBadgeFull}>Model-based — TPR/FPR from confusion matrix</span>
              : <span className={styles.modeBadgeLabel}>Label-only — add prediction column for true Equalized Odds</span>
            }
            <p className={styles.tabSubtitle}>Charts and tables showing exactly where disparity exists.</p>

            {groupChartData.length > 0 && (
              <div className={styles.card}>
                <h3 className={styles.cardTitle}>Pass Rate by Group</h3>
                <p className={styles.cardHint}>Green = highest · Red = lowest (most affected)</p>
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={groupChartData} barCategoryGap="40%">
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
                    <XAxis dataKey="name" tick={{ fill: 'var(--text-muted)', fontSize: 13 }}/>
                    <YAxis unit="%" domain={[0, 110]} tick={{ fill: 'var(--text-muted)', fontSize: 12 }}/>
                    <Tooltip formatter={v => [`${v}%`, 'Pass Rate']} {...tt}/>
                    <Bar dataKey="Pass Rate (%)" radius={[6, 6, 0, 0]} maxBarSize={80}>
                      <LabelList dataKey="Pass Rate (%)" position="top" formatter={v => `${v}%`}
                        style={{ fill: 'var(--text)', fontSize: 12, fontWeight: 700 }}/>
                      {groupChartData.map((entry, i) => <Cell key={i} fill={entry.fill} fillOpacity={0.88}/>)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {!has_predictions && (
              <div className={styles.labelOnlyNotice}>
                <Icon name="insights" size={15}/>
                <p>Equalized Odds (TPR & FPR) requires a prediction column. In label-only mode these are not computed.</p>
              </div>
            )}
            {has_predictions && eoChartData.length > 0 && (
              <div className={styles.card}>
                <h3 className={styles.cardTitle}>Equalized Odds — TPR & FPR per Group</h3>
                <p className={styles.cardHint}>Ideally both are equal across groups — gaps reveal unequal outcomes.</p>
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={eoChartData} barCategoryGap="30%" barGap={4}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
                    <XAxis dataKey="name" tick={{ fill: 'var(--text-muted)', fontSize: 13 }}/>
                    <YAxis unit="%" domain={[0, 110]} tick={{ fill: 'var(--text-muted)', fontSize: 12 }}/>
                    <Tooltip formatter={(v, n) => [`${v}%`, n]} {...tt}/>
                    <Legend wrapperStyle={{ fontSize: 12, color: 'var(--text-muted)' }}/>
                    <Bar dataKey="TPR (%)" fill="var(--primary)" fillOpacity={0.85} radius={[4, 4, 0, 0]} maxBarSize={60}>
                      <LabelList dataKey="TPR (%)" position="top" formatter={v => `${v}%`}
                        style={{ fill: 'var(--text)', fontSize: 11, fontWeight: 600 }}/>
                    </Bar>
                    <Bar dataKey="FPR (%)" fill="var(--red)" fillOpacity={0.75} radius={[4, 4, 0, 0]} maxBarSize={60}>
                      <LabelList dataKey="FPR (%)" position="top" formatter={v => `${v}%`}
                        style={{ fill: 'var(--text)', fontSize: 11, fontWeight: 600 }}/>
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            <h3 className={styles.subTitle}>All Fairness Metrics</h3>
            <div className={styles.metricsGrid}>
              {metrics.map(m => <MetricCard key={m.key} metric={m} plainLang={plain_language[m.key]}/>)}
            </div>

            {group_stats.length > 0 && (
              <div className={styles.card}>
                <h3 className={styles.cardTitle}>Group Statistics Table</h3>
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>Group</th><th>Count</th>
                        {/* Show all numeric columns from avg_by_col if available, else fallback to avg_value */}
                        {group_stats[0]?.avg_by_col && Object.keys(group_stats[0].avg_by_col).length > 0
                          ? Object.keys(group_stats[0].avg_by_col).map(col => <th key={col}>Avg {col}</th>)
                          : group_stats[0]?.avg_value != null && <th>Avg Value</th>
                        }
                        <th>Pass</th><th>Fail</th><th>Pass Rate</th>
                        {group_stats[0]?.tpr != null && <th>TPR</th>}
                        {group_stats[0]?.fpr != null && <th>FPR</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {group_stats.map(g => (
                        <tr key={g.group} className={g.pass_rate === minRate ? styles.rowLowest : ''}>
                          <td>
                            <strong>{g.group}</strong>
                            {g.pass_rate === minRate && <span className={styles.lowestTag}>most affected</span>}
                          </td>
                          <td>{g.count}</td>
                          {g.avg_by_col && Object.keys(g.avg_by_col).length > 0
                            ? Object.keys(g.avg_by_col).map(col => (
                                <td key={col}>{g.avg_by_col[col]?.toFixed(1) ?? '—'}</td>
                              ))
                            : group_stats[0]?.avg_value != null && <td>{g.avg_value?.toFixed(1) ?? '—'}</td>
                          }
                          <td style={{ color: 'var(--green)' }}>{g.pass_count}</td>
                          <td style={{ color: 'var(--red)' }}>{g.fail_count}</td>
                          <td>
                            <span className={`${styles.ratePill} ${g.pass_rate === maxRate ? styles.rateHigh : g.pass_rate === minRate ? styles.rateLow : styles.rateMid}`}>
                              {(g.pass_rate * 100).toFixed(1)}%
                            </span>
                          </td>
                          {group_stats[0]?.tpr != null && <td>{g.tpr != null ? `${(g.tpr*100).toFixed(1)}%` : '—'}</td>}
                          {group_stats[0]?.fpr != null && <td>{g.fpr != null ? `${(g.fpr*100).toFixed(1)}%` : '—'}</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Numeric column gaps breakdown */}
            {all_numeric_gaps.length > 0 && (
              <div className={styles.card}>
                <h3 className={styles.cardTitle}>Numeric Column Gaps by Group</h3>
                <p className={styles.cardHint}>
                  Gap = (highest group avg − lowest group avg) / column range × 100.
                  Flagged if &gt; 10%. The column with the largest gap drives the Performance Gap metric.
                </p>
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>Column</th>
                        <th>Gap %</th>
                        <th>Raw Gap</th>
                        <th>Lowest Group</th>
                        <th>Highest Group</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...all_numeric_gaps].sort((a, b) => b.gap_pct - a.gap_pct).map(g => (
                        <tr key={g.col}>
                          <td><strong>{g.col}</strong></td>
                          <td>{g.gap_pct.toFixed(1)}%</td>
                          <td>{g.gap_raw.toFixed(2)}</td>
                          <td style={{ color: 'var(--red)' }}>{g.lo_group} ({g.lo_avg})</td>
                          <td style={{ color: 'var(--green)' }}>{g.hi_group} ({g.hi_avg})</td>
                          <td>
                            <span className={`${styles.badge} ${g.gap_pct > 10 ? styles.badgeRed : styles.badgeGreen}`}>
                              {g.gap_pct > 10 ? 'Flagged' : 'OK'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Numeric feature gap analysis */}
            {all_numeric_gaps?.length > 1 && (
              <div className={styles.card}>
                <h3 className={styles.cardTitle}>Numeric Feature Gaps by Group</h3>
                <p className={styles.cardHint}>
                  Larger gaps in numeric features may reveal hidden drivers of bias.
                  Sorted by severity — gap expressed as % of each column's full range.
                </p>
                <div className={styles.numericGapsGrid}>
                  {[...all_numeric_gaps].sort((a, b) => b.gap_pct - a.gap_pct).map(gap => (
                    <div key={gap.col} className={`${styles.numericGapItem} ${gap.gap_pct > 10 ? styles.numericGapFlagged : ''}`}>
                      <div className={styles.numericGapHeader}>
                        <span className={styles.numericGapCol}>{gap.col}</span>
                        <span className={styles.numericGapPct}
                          style={{ color: gap.gap_pct > 10 ? 'var(--red)' : gap.gap_pct > 5 ? 'var(--amber)' : 'var(--green)' }}>
                          {gap.gap_pct.toFixed(1)}%
                        </span>
                      </div>
                      <div className={styles.numericGapBar}>
                        <div className={styles.numericGapFill}
                          style={{
                            width: `${Math.min(gap.gap_pct * 5, 100)}%`,
                            background: gap.gap_pct > 10 ? 'var(--red)' : gap.gap_pct > 5 ? 'var(--amber)' : 'var(--green)'
                          }}/>
                      </div>
                      <div className={styles.numericGapGroups}>
                        {Object.entries(gap.avgs || {}).sort(([,a],[,b]) => b-a).map(([grp, avg]) => (
                          <span key={grp} className={styles.numericGapGroup}>
                            <strong>{grp}</strong> {avg}
                          </span>
                        ))}
                        <span className={styles.numericGapRaw}>raw gap: {gap.gap_raw}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

          </div>
        )}

        {/* ══ FIX BIAS ══ */}
        {activeTab === 'fix' && (
          <div className={styles.tabContent}>
            <h2 className={styles.tabTitle}>Fix Bias</h2>
            <p className={styles.tabSubtitle}>
              Four scenario-aware mitigation strategies evaluated automatically.
              Ranked by: <strong>0.4 × DPD_reduction + 0.4 × est_accuracy + 0.2 × rate_stability</strong> (confidence-discounted).
              Scores are computed from dataset statistics and model outputs (Python/scikit-learn/scipy); AI generates explanation text only.
            </p>

            {!mitigation ? (
              <div className={styles.emptyState}><p>Run an audit to see mitigation results.</p></div>
            ) : (
              <>
                <div className={styles.projectionNotice}>
                  <Icon name="insights" size={14}/>
                  <span>Mitigation outcomes are computed from scenario-aware runs on this dataset (reweighing, disparate impact remover, threshold optimization, reject option classification), not pseudo-calculations.</span>
                </div>

                {/* Banner */}
                <div className={styles.simResultBanner}>
                  <div className={styles.simBannerScore}>
                    <div className={styles.simBannerItem}>
                      <span className={styles.simBannerLabel}>Current Bias</span>
                      <span className={styles.simBannerNum} style={{ color: 'var(--red)' }}>{mitigation.bias_before}</span>
                    </div>
                    <span className={styles.simBannerArrow}>→</span>
                    <div className={styles.simBannerItem}>
                      <span className={styles.simBannerLabel}>Projected Best</span>
                      <span className={styles.simBannerNum} style={{ color: 'var(--green)' }}>{mitigation.bias_after}</span>
                    </div>
                  </div>
                  <div className={styles.simBannerImprovement}>
                    <span className={styles.simBannerImpLabel}>Best Method: {mitigation.best_method.split('_').map(w=>w[0].toUpperCase()+w.slice(1)).join(' ')}</span>
                    <span className={styles.simBannerImpHeadline}>{toCompactSentence(mitigation.trade_off_summary, 190)}</span>
                    {mitigation.selection_reason && (
                      <span className={styles.simBannerImpDetail}><strong>Why selected:</strong> {toCompactSentence(mitigation.selection_reason, 175)}</span>
                    )}
                  </div>
                </div>

                {/* Chart — use full 0-100 scale so bars are visible */}
                <div className={styles.card}>
                  <h3 className={styles.cardTitle}>Bias Score by Method</h3>
                  <p className={styles.cardHint}>Lower is better · Green = recommended method · Values are from executed runs</p>
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={mitigationChartData} barCategoryGap="25%" barSize={80}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
                      <XAxis dataKey="name" tick={{ fill: 'var(--text-muted)', fontSize: 12 }}/>
                      <YAxis domain={[0, Math.max(mitigation.bias_before * 1.1, 10)]}
                        tick={{ fill: 'var(--text-muted)', fontSize: 12 }}
                        label={{ value: 'Bias Score', angle: -90, position: 'insideLeft', fill: 'var(--text-muted)', fontSize: 11 }}/>
                      <Tooltip
                        formatter={(v, n, p) => [
                          `${v} bias after mitigation${p.payload.accuracy != null ? ` | Accuracy: ${(p.payload.accuracy*100).toFixed(1)}%` : ''}`,
                          p.payload.isBest ? '★ Recommended' : p.payload.name
                        ]}
                        {...tt}/>
                      <Bar dataKey="score" radius={[6, 6, 0, 0]} minPointSize={4}>
                        <LabelList dataKey="score" position="top"
                          style={{ fill: 'var(--text)', fontSize: 13, fontWeight: 700 }}/>
                        {mitigationChartData.map((entry, i) => (
                          <Cell key={i} fill={entry.fill} fillOpacity={entry.isBest ? 1.0 : 0.7}/>
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                {/* Method cards */}
                <div className={styles.mitigationGrid}>
                  {(mitigation.results || []).map(r => (
                    <div key={r.method}
                      className={`${styles.mitigationCard} ${r.method === mitigation.best_method ? styles.mitigationCardBest : ''}`}>
                      {r.method === mitigation.best_method && (
                        <div className={styles.bestBadge}>Recommended</div>
                      )}
                      <h4 className={styles.mitigationMethod}>
                        {r.method === 'threshold_optimisation'
                          ? 'Threshold Optimization'
                          : r.method.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
                      </h4>
                      <p className={styles.mitigationDesc}>{r.description}</p>
                      {r.scenario_reason && (
                        <p className={styles.mitigationDesc}><strong>Scenario rule:</strong> {r.scenario_reason}</p>
                      )}
                      <div className={styles.mitigationStats}>
                        <div className={styles.mitigationStat}>
                          <span className={styles.mitigationStatLabel}>Bias After Mitigation</span>
                          <span className={styles.mitigationStatVal}
                            style={{ color: r.bias_score < 20 ? 'var(--green)' : r.bias_score < 45 ? 'var(--amber)' : 'var(--red)' }}>
                            {r.bias_score} / 100
                          </span>
                        </div>
                        <div className={styles.mitigationStat}>
                          <span className={styles.mitigationStatLabel}>Bias Reduction</span>
                          <span className={styles.mitigationStatVal}
                            style={{ color: r.improvement > 0 ? 'var(--green)' : 'var(--red)' }}>
                            {r.improvement > 0 ? `↓ ${r.improvement} pts` : `↑ ${Math.abs(r.improvement)} pts`}
                          </span>
                        </div>
                        <div className={styles.mitigationStat}>
                          <span className={styles.mitigationStatLabel}>Accuracy (upper bound)</span>
                          <span className={styles.mitigationStatVal}>
                            {r.accuracy != null ? `${(r.accuracy*100).toFixed(1)}%` : '—'}
                          </span>
                        </div>
                        <div className={styles.mitigationStat}>
                          <span className={styles.mitigationStatLabel}>DPD After</span>
                          <span className={styles.mitigationStatVal}>{r.dpd.toFixed(4)}</span>
                        </div>
                        <div className={styles.mitigationStat}>
                          <span className={styles.mitigationStatLabel}>Rank Score</span>
                          <span className={styles.mitigationStatVal}
                            style={{ color: r.final_score >= 0 ? 'var(--text)' : 'var(--red)' }}>
                            {r.final_score >= 0 ? r.final_score.toFixed(3) : 'Invalid'}
                          </span>
                        </div>
                        <div className={styles.mitigationStat}>
                          <span className={styles.mitigationStatLabel}>TPR/FPR</span>
                          <span className={styles.mitigationStatVal} style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                            {has_predictions ? (r.tpr_gap?.toFixed(4) ?? '—') : 'Label-only'}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <div className={styles.bestReasonCard}>
                  <Icon name="check" size={16}/>
                  <p className={styles.bestReasonText}>{mitigation.best_reason}</p>
                </div>
              </>
            )}
          </div>
        )}

        {/* ══ AI INSIGHTS ══ */}
        {activeTab === 'insights' && (
          <div className={styles.tabContent}>
            <h2 className={styles.tabTitle}>AI Insights</h2>
            <p className={styles.tabSubtitle}>Generated by Gemini 2.5 Flash, grounded in computed statistics.</p>

            <div className={styles.card}>
              <h3 className={styles.cardTitle}>Bias Narrative</h3>
              <div className={styles.summaryParas}>
                {summary.split('\n\n').map((p, i) => <p key={i} className={styles.summaryPara}>{p}</p>)}
              </div>
            </div>

            <div className={styles.twoCol}>
              <div className={styles.card}>
                <h3 className={styles.cardTitle}>Key Findings</h3>
                <ol className={styles.findingList}>
                  {key_findings.map((f, i) => <li key={i} className={styles.findingItem}>{f}</li>)}
                </ol>
              </div>
              <div className={styles.card}>
                <h3 className={styles.cardTitle}>Recommendations</h3>
                <ul className={styles.recList}>
                  {recommendations.map((r, i) => (
                    <li key={i} className={styles.recItem}><span className={styles.recArrow}>→</span>{r}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}

        {/* ══ WHAT-IF EXPERIMENTS ══ */}
        {activeTab === 'whatif' && (
          <div className={styles.tabContent}>
            <h2 className={styles.tabTitle}>What-If / Counterfactual Analysis</h2>
            <p className={styles.tabDesc}>
              Select any real record and change its <strong>{sensitive_column}</strong> value to see how that individual's statistical outcome likelihood would change —
              a direct implementation of GDPR Art. 22 counterfactual explanation rights confirmed by CJEU C-203/22.
            </p>
            <div className={styles.whatIfStack}>
              <CounterfactualEditor sampleRows={sample_rows} sensitiveCol={sensitive_column} groupRatesMap={group_rates_map} allNumericGaps={all_numeric_gaps} />
            </div>
          </div>
        )}

        {/* ══ VERSIONS ══ */}
        {activeTab === 'versions' && (
          <div className={styles.tabContent}>
            <h2 className={styles.tabTitle}>Bias Version Control</h2>
            <p className={styles.tabDesc}>
              Compare your current audit against past audits to track fairness progress over time.
            </p>
            <VersionCompare currentResult={result} />
          </div>
        )}

        {/* ══ TRANSPARENCY ══ */}
        {activeTab === 'transparency' && (
          <div className={styles.tabContent}>
            <h2 className={styles.tabTitle}>Transparency</h2>
            <p className={styles.tabSubtitle}>Everything FairLens used — no black boxes.</p>

            <div className={styles.transpGrid}>
              {[
                { label: 'Dataset size',       value: `${total_rows?.toLocaleString()} rows` },
                { label: 'Total columns',      value: columns?.length },
                { label: 'Sensitive attribute',value: sensitive_column || 'auto-detected' },
                { label: 'Target column',      value: target_column || 'auto-detected' },
                { label: 'Prediction column',  value: prediction_column || 'none (label-only)' },
                { label: 'Mode',               value: has_predictions ? 'Model-based' : 'Label-only' },
                { label: 'Groups analyzed',    value: group_stats.length },
                { label: 'Metrics flagged',    value: `${flaggedMetrics.length} / ${metrics.length}`, color: flaggedMetrics.length > 0 ? 'var(--red)' : 'var(--green)' },
                { label: 'Data reliability',   value: `${reliabilityData.reliability ?? '—'} (${reliabilityData.confidence_score ?? '—'}/100)`, color: reliabilityColor },
              ].map((item, i) => (
                <div key={i} className={styles.transpCard}>
                  <span className={styles.transpLabel}>{item.label}</span>
                  <span className={styles.transpValue} style={item.color ? { color: item.color } : {}}>{item.value}</span>
                </div>
              ))}
            </div>

            {reliabilityData.warnings?.length > 0 && (
              <div className={styles.card}>
                <h3 className={styles.cardTitle}>Data Warnings</h3>
                <ul className={styles.causeList}>
                  {reliabilityData.warnings.map((w, i) => (
                    <li key={i} className={styles.causeItem}><span className={styles.warnDot}/>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className={styles.card}>
              <h3 className={styles.cardTitle}>Bias Score Formula</h3>
              <div className={styles.formulaBox}>
                <p style={{whiteSpace: 'pre-wrap'}}>{has_predictions
                  ? [
                      '── Model-based mode (prediction column present) ────────────────',
                      '',
                      'bias_score = mean([dpd_v, dir_v, tpr_v, fpr_v]) × 100',
                      '           = 4 violations averaged equally',
                      '',
                      'dpd_v = min(DPD / 0.10, 1.0)',
                      '        where DPD = max(pass_rates) - min(pass_rates)',
                      '        Flagged if DPD > 0.10',
                      '',
                      'dir_v = 0                          if DIR >= 0.80  (EU 4/5 rule — passing)',
                      '      = min((0.80 - DIR) / 0.80, 1)  if DIR < 0.80   (EU 4/5 rule — failing)',
                      '        where DIR = min(pass_rates) / max(pass_rates)',
                      '',
                      'tpr_v = min(TPR_gap / 0.10, 1.0)   [Equal Opportunity — requires predictions]',
                      'fpr_v = min(FPR_gap / 0.10, 1.0)   [Equalized Odds — requires predictions]',
                      '',
                      '── Thresholds ─────────────────────────────────────────────────',
                      'DPD threshold  : < 0.10   (EU best practice)',
                      'DIR threshold  : >= 0.80  (EU 4/5 / 80% rule)',
                      'TPR/FPR thresh : < 0.10   (equal opportunity standard)',
                    ].join('\n')
                  : [
                      '── Label-only mode (no prediction column) ───────────────────────',
                      '',
                      'bias_score = mean([dpd_v, dir_v]) × 100',
                      '           = 2 violations averaged equally',
                      '',
                      'dpd_v = min(DPD / 0.10, 1.0)',
                      '        where DPD = max(pass_rates) - min(pass_rates)',
                      '        Flagged if DPD > 0.10',
                      '',
                      'dir_v = 0                          if DIR >= 0.80  (EU 4/5 rule — passing)',
                      '      = min((0.80 - DIR) / 0.80, 1)  if DIR < 0.80   (EU 4/5 rule — failing)',
                      '        where DIR = min(pass_rates) / max(pass_rates)',
                      '',
                      'TPR/FPR: NOT computed — no prediction column provided.',
                      'Add a prediction column to enable Equal Opportunity & Equalized Odds metrics.',
                      '',
                      '── Thresholds ─────────────────────────────────────────────────',
                      'DPD threshold  : < 0.10   (EU best practice)',
                      'DIR threshold  : >= 0.80  (EU 4/5 / 80% rule)',
                    ].join('\n')
                }</p>
                <p className={styles.formulaNote}>
                  All fairness metrics computed in Python (audit_service.py). Gemini 2.5 Flash writes narrative text only — it never modifies numeric results.
                  Theil index uses group-level rate formula: mean((r/mean_r)·ln(r/mean_r)). Performance gap normalised to column range.
                  Statistical significance uses Pearson chi-square on the sensitive×target contingency table (scipy.stats.chi2_contingency with correction disabled).
                  Cramér&apos;s V uses bias correction (Bergsma, 2013). Steps: φ²=χ²/n; φ²corr=max(0, φ²-((k−1)(r−1))/(n−1)); rows_corrected=r-((r−1)²/(n−1)); cols_corrected=k-((k−1)²/(n−1)); V=sqrt(φ²corr/min(cols_corrected−1, rows_corrected−1)).
                  Effect size bands: V&lt;0.10 negligible · 0.10–0.20 small · 0.20–0.40 medium · ≥0.40 large.
                  Bias score range: 0–19 = Low · 20–44 = Moderate · 45–69 = High · 70–100 = Critical.
                </p>
              </div>
            </div>

            {Array.isArray(compliance?.gap_matrix) && compliance.gap_matrix.length > 0 && (
              <div className={styles.card}>
                <h3 className={styles.cardTitle}>EU AI Act Gap Matrix (Dedicated)</h3>
                {compliance?.compliance_rating && (
                  <p className={styles.cardHint}>
                    Compliance Rating: <strong>{Number(compliance.compliance_rating.score_1_to_10).toFixed(1)}/10</strong> — {compliance.compliance_rating.label}
                    {' · '}{compliance.compliance_rating.rationale}
                  </p>
                )}
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>Article</th>
                        <th>Status</th>
                        <th>Rationale</th>
                        <th>Detected Gaps</th>
                      </tr>
                    </thead>
                    <tbody>
                      {compliance.gap_matrix.map((row, idx) => (
                        <tr key={`${row.article}-${idx}`}>
                          <td><strong>{row.article}</strong></td>
                          <td>
                            <span className={`${styles.badge} ${
                              row.status === 'Green' ? styles.badgeGreen :
                              row.status === 'Amber' ? styles.badgeAmber : styles.badgeRed
                            }`}>
                              {row.status}
                            </span>
                          </td>
                          <td>{row.rationale}</td>
                          <td>
                            {Array.isArray(row.gaps) && row.gaps.length > 0 ? row.gaps.join(' · ') : 'No material gaps detected'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {Array.isArray(compliance?.remaining_controls) && compliance.remaining_controls.length > 0 && (
                  <>
                    <h3 className={styles.cardTitle} style={{ marginTop: 16 }}>Remaining Product/Process Controls</h3>
                    <div className={styles.tableWrap}>
                      <table className={styles.table}>
                        <thead>
                          <tr>
                            <th>Control ID</th>
                            <th>Article</th>
                            <th>Priority</th>
                            <th>Owner</th>
                            <th>Required Control</th>
                          </tr>
                        </thead>
                        <tbody>
                          {compliance.remaining_controls.map((c, idx) => (
                            <tr key={`${c.id || 'ctrl'}-${idx}`}>
                              <td><strong>{c.id || 'CONTROL'}</strong></td>
                              <td>{c.article || 'N/A'}</td>
                              <td>
                                <span className={`${styles.badge} ${
                                  String(c.priority).toLowerCase() === 'high' ? styles.badgeRed :
                                  String(c.priority).toLowerCase() === 'medium' ? styles.badgeAmber : styles.badgeGreen
                                }`}>
                                  {c.priority || 'medium'}
                                </span>
                              </td>
                              <td>{c.owner || 'Owner not assigned'}</td>
                              <td>{c.control || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            )}

            <div className={styles.card}>
              <h3 className={styles.cardTitle}>All Columns</h3>
              <div className={styles.columnPills}>
                {columns?.map(c => (
                  <span key={c} className={`${styles.colPill} ${c === sensitive_column ? styles.colPillSensitive : c === target_column ? styles.colPillTarget : c === prediction_column ? styles.colPillPred : ''}`}>
                    {c}
                    {c === sensitive_column && <span className={styles.colTag}>sensitive</span>}
                    {c === target_column && <span className={styles.colTag}>target</span>}
                    {c === prediction_column && <span className={styles.colTag}>prediction</span>}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ══ ASK AI ══ */}
        {activeTab === 'ask' && (
          <div className={styles.tabContentAsk}>
            <ChatPanel datasetDescription={datasetDescription} auditSummary={audit_summary_json}/>
          </div>
        )}

      </div>
      
      {showBadgeModal && <BadgeModal result={result} onClose={() => setShowBadgeModal(false)} />}
    </div>
  );
}
