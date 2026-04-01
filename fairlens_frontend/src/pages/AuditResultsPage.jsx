import { useState, useRef, useEffect } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { decodeShareData, buildShareUrl } from '../api/share'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, Cell, LabelList, Legend,
} from 'recharts'
import { sendChatMessage } from '../api/audit'
import { exportAuditToPdf } from '../api/exportPdf'
import BiasGauge from '../components/BiasGauge'
import ThemeToggle from '../components/ThemeToggle'
import Icon from '../components/Icon'
import VersionCompare from '../components/VersionCompare'
import BadgeModal from '../components/BadgeModal'
import styles from './AuditResultsPage.module.css'

// ── Metric Card ───────────────────────────────────────────────────────────────
function getMetricTooltip(metricKey) {
  const tooltipMap = {
    demographic_parity_difference: 'Absolute difference in positive outcome rates between groups.',
    disparate_impact_ratio: 'Ratio of lowest to highest group selection rate. >=0.80 preferred.',
    theil_index: 'Inequality index across groups; lower is better.',
    tpr_gap: 'Difference in true positive rates across groups.',
    fpr_gap: 'Difference in false positive rates across groups.',
  }
  return tooltipMap[metricKey] || 'Metric detail'
}

function MetricCard({ metric, plainLang }) {
  const val = metric.value ?? 0
  const thr = metric.threshold ?? 1
  const scale = Math.max(val, thr) * 1.25 || 1
  const pct = Math.min((val / scale) * 100, 100)
  const threshPos = Math.min((thr / scale) * 100, 100)
  return (
    <div className={`${styles.metricCard} ${metric.flagged ? styles.metricFlagged : styles.metricOk}`}>
      <div className={styles.metricHeader}>
        <span className={styles.metricName}>{metric.name}</span>
        <span title={getMetricTooltip(metric.key)}>
          ⓘ
        </span>
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
function CounterfactualEditor({ sampleRows, sensitiveCol, groupRatesMap }) {
  const [selectedRowIndex, setSelectedRowIndex] = useState(null)
  const [editedValue, setEditedValue] = useState('')

  if (!sampleRows || sampleRows.length === 0) return <p style={{ color: 'var(--text-muted)' }}>No sample data available for what-if analysis.</p>

  const normalizedRates = Object.entries(groupRatesMap || {}).reduce((acc, [k, v]) => {
    acc[normalizeGroup(k)] = v
    return acc
  }, {})

  useEffect(() => {
    if (selectedRowIndex === null && sampleRows.length > 0) {
      const initialValue = normalizeGroup(sampleRows[0][sensitiveCol])
      setSelectedRowIndex(0)
      setEditedValue(initialValue)
    }
  }, [selectedRowIndex, sampleRows, sensitiveCol])

  const activeRow = selectedRowIndex !== null ? sampleRows[selectedRowIndex] : null
  const originalValue = activeRow ? normalizeGroup(activeRow[sensitiveCol]) : ''
  
  const originalRate = originalValue ? normalizedRates[originalValue] : null
  const newRate = editedValue ? normalizedRates[editedValue] : null
  const diff = (originalRate != null && newRate != null) ? (newRate - originalRate) * 100 : 0
  
  const availableGroups = Object.keys(normalizedRates)

  return (
    <div className={styles.cfContainer}>
      <div className={styles.cfTableWrap}>
        <table className={styles.cfTable}>
          <thead>
            <tr>
              {Object.keys(sampleRows[0]).slice(0, 10).map(k => <th key={k}>{k} {k===sensitiveCol?'(S)':''}</th>)}
            </tr>
          </thead>
          <tbody>
            {sampleRows.map((row, i) => (
              <tr key={i} className={selectedRowIndex === i ? styles.cfActiveRow : ''} onClick={() => { setSelectedRowIndex(i); setEditedValue(normalizeGroup(row[sensitiveCol])) }}>
                {Object.keys(row).slice(0, 10).map(k => <td key={k}>{String(row[k])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {activeRow && (
        <div className={styles.cfEditor}>
          <h3>Counterfactual Editor</h3>
          <p>Modify the sensitive attribute <strong>{sensitiveCol}</strong> for this individual to see how the statistical likelihood of a positive outcome changes based on group disparity data.</p>
          <div className={styles.cfField}>
            <label>Original {sensitiveCol}:</label>
            <input disabled value={originalValue} />
          </div>
          <div className={styles.cfField}>
            <label>Counterfactual {sensitiveCol}:</label>
            <select value={editedValue} onChange={e => setEditedValue(e.target.value)}>
              {availableGroups.map(g => <option key={g} value={g}>{g}</option>)}
            </select>
          </div>
          <div className={styles.cfResult}>
            <div className={styles.cfRateBox}>
              <span>Original Likelihood</span>
              <strong>{originalRate != null ? (originalRate * 100).toFixed(1) + '%' : 'N/A'}</strong>
            </div>
            <div className={styles.cfArrow}>→</div>
            <div className={styles.cfRateBox}>
              <span>New Likelihood</span>
              <strong>{newRate != null ? (newRate * 100).toFixed(1) + '%' : 'N/A'}</strong>
            </div>
          </div>
          <div className={`${styles.cfDiff} ${diff > 0 ? styles.cfDiffUp : diff < 0 ? styles.cfDiffDown : ''}`}>
             Difference: {diff > 0 ? '+' : ''}{diff.toFixed(1)}% 
             {diff !== 0 && (diff > 0 ? ' (More likely to pass)' : ' (Less likely to pass)')}
          </div>
        </div>
      )}
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
  const [showBadgeModal, setShowBadgeModal] = useState(false)
  const [pdfPreviewUrl, setPdfPreviewUrl] = useState('')
  const [searchParams] = useSearchParams()

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
    fairness_grade,
    privacy_mode,
    integrity_hash,
    compliance_result,
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
    setExporting(true)
    try {
      const out = await exportAuditToPdf(result, datasetDescription)
      if (out?.url) setPdfPreviewUrl(out.url)
    } finally { setExporting(false) }
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
                {fairness_grade && (
                  <div className={styles.riskBadge} style={{ marginTop: 8 }}>
                    Fairness Grade: {fairness_grade}
                  </div>
                )}
                {privacy_mode && (
                  <div className={styles.riskBadge} style={{ marginTop: 8 }}>
                    Privacy Mode Enabled
                  </div>
                )}
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
              {metrics.filter(m => ['demographic_parity_difference', 'disparate_impact_ratio'].includes(m.key)).map(m => (
                <MetricCard key={m.key} metric={m} plainLang={plain_language[m.key]}/>
              ))}
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
            <div className={styles.card}>
              <h3 className={styles.cardTitle}>Compliance Engine Output</h3>
              <pre style={{ whiteSpace: 'pre-wrap', color: 'var(--text-muted)' }}>
                {JSON.stringify(compliance_result || {}, null, 2)}
              </pre>
              {integrity_hash && <p><strong>Integrity Hash:</strong> {integrity_hash}</p>}
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
              Three mitigation strategies evaluated automatically.
              Ranked by: <strong>0.4 × DPD_reduction + 0.4 × est_accuracy + 0.2 × rate_stability</strong> (confidence-discounted).
              All values are projections — actual improvement requires implementation.
            </p>

            {!mitigation ? (
              <div className={styles.emptyState}><p>Run an audit to see mitigation results.</p></div>
            ) : (
              <>
                {/* Projection disclaimer */}
                <div className={styles.projectionNotice}>
                  <Icon name="insights" size={14}/>
                  <span>These are <strong>projected</strong> outcomes — simulations of what each technique could achieve. Actual results depend on model retraining and implementation.</span>
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
                    <span className={styles.simBannerImpVal}>{mitigation.trade_off_summary}</span>
                  </div>
                </div>

                {/* Chart — use full 0-100 scale so bars are visible */}
                <div className={styles.card}>
                  <h3 className={styles.cardTitle}>Projected Bias Score by Method</h3>
                  <p className={styles.cardHint}>Lower is better · Green = recommended method · All values are projections</p>
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={mitigationChartData} barCategoryGap="25%" barSize={80}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
                      <XAxis dataKey="name" tick={{ fill: 'var(--text-muted)', fontSize: 12 }}/>
                      <YAxis domain={[0, Math.max(mitigation.bias_before * 1.1, 10)]}
                        tick={{ fill: 'var(--text-muted)', fontSize: 12 }}
                        label={{ value: 'Bias Score', angle: -90, position: 'insideLeft', fill: 'var(--text-muted)', fontSize: 11 }}/>
                      <Tooltip
                        formatter={(v, n, p) => [
                          `${v} projected bias${p.payload.accuracy != null ? ` | Accuracy: ${(p.payload.accuracy*100).toFixed(1)}%` : ''}`,
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
                        {r.method === 'rate_equalisation' ? 'Rate Equalisation' : r.method.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
                      </h4>
                      <p className={styles.mitigationDesc}>{r.description}</p>
                      <div className={styles.mitigationStats}>
                        <div className={styles.mitigationStat}>
                          <span className={styles.mitigationStatLabel}>Projected Bias</span>
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
            <h2 className={styles.tabTitle}>Counterfactual Row Editor</h2>
            <p className={styles.tabDesc}>
              Select a real record from your dataset and modify its sensitive attributes string to simulate counterfactual fairness decisions based on historical group bias.
            </p>
            <CounterfactualEditor sampleRows={sample_rows} sensitiveCol={sensitive_column} groupRatesMap={group_rates_map} />
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
                      'bias_score = (0.40 x dpd_v + 0.25 x dir_v + 0.20 x tpr_v + 0.15 x fpr_v) x 100',
                      '',
                      'dpd_v = graduated curve (not hard cap):',
                      '  DPD <= 0.10 : dpd_v = DPD / 0.10 x 0.75    (0.05 -> 0.375, 0.10 -> 0.75)',
                      '  DPD >  0.10 : dpd_v = 0.75 + 0.25 x sqrt((DPD - 0.10) / 0.90)',
                      '                        (0.20 -> 0.88, 0.40 -> 0.94, 1.0 -> 1.0)',
                      'dir_v = 0 if DIR >= 0.80 else min((0.80 - DIR) / 0.80, 1)   [legal 4/5 rule]',
                      'tpr_v = same graduated curve scaled to 0.10 threshold        [Equal Opportunity]',
                      'fpr_v = same graduated curve scaled to 0.10 threshold        [Equalized Odds]',
                    ].join('\n')
                  : [
                      'bias_score = (0.60 x dpd_v + 0.40 x dir_v) x 100',
                      '',
                      'dpd_v = graduated curve (not hard cap):',
                      '  DPD <= 0.10 : dpd_v = DPD / 0.10 x 0.75    (0.05 -> 0.375, 0.10 -> 0.75)',
                      '  DPD >  0.10 : dpd_v = 0.75 + 0.25 x sqrt((DPD - 0.10) / 0.90)',
                      '                        (0.20 -> 0.88, 0.40 -> 0.94, 1.0 -> 1.0)',
                      'dir_v = 0 if DIR >= 0.80 else min((0.80 - DIR) / 0.80, 1)   [legal 4/5 rule]',
                      '',
                      'DPD weighted 0.60 (primary metric), DIR weighted 0.40 (legal dimension).',
                      'Weighted not averaged -- avoids double-counting the same disparity.',
                      'Graduated curve -- DPD=0.11 and DPD=0.80 score differently (no hard cap).',
                      'TPR/FPR excluded: no prediction column (label-only mode).',
                    ].join('\n')
                }</p>
                <p className={styles.formulaNote}>
                  All metrics computed in Python. Gemini writes narrative text only.
                  Theil uses population-weighted formula. Performance gap normalised to column range.
                  Chi-square + Cramer&apos;s V: V&lt;0.10 negligible, 0.10-0.20 small, 0.20-0.40 medium, &gt;=0.40 large.
                </p>
              </div>
            </div>

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
            {pdfPreviewUrl && (
              <div className={styles.card}>
                <h3 className={styles.cardTitle}>PDF Preview</h3>
                <iframe title="Compliance PDF preview" src={pdfPreviewUrl} style={{ width: '100%', height: 500, border: '1px solid var(--border)' }} />
              </div>
            )}
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
