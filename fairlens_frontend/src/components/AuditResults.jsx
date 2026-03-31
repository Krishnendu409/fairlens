import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import RiskGauge from './RiskGauge'
import BiasGauge from './BiasGauge'
import MetricsTable from './MetricsTable'
import RadarChart from './RadarChart'
import FairnessComparisonChart from './FairnessComparisonChart'
import { downloadBase64File } from '../api/audit'
import { buildShareUrl } from '../api/share'
import { exportAuditToPdf } from '../api/exportPdf'
import Icon from './Icon'
import styles from './AuditResults.module.css'

const STRATEGY_LABELS = {
  reweighing: 'Reweighing',
  threshold_optimizer: 'Threshold Optimisation',
  drop_sensitive: 'Drop Sensitive Features',
}

const MODEL_LABELS = {
  logistic_regression: 'Logistic Regression',
  decision_tree: 'Decision Tree',
  random_forest: 'Random Forest',
  gradient_boosting: 'Gradient Boosting',
}

export default function AuditResults({ result, targetColumn, sensitiveColumn, onReset, standalone }) {
  const navigate = useNavigate()
  const [shareState, setShareState] = useState('idle')
  const [exporting, setExporting] = useState(false)
  const [activeTab, setActiveTab] = useState('overview') // overview | metrics | groups | insights

  const {
    fairness_metrics_before, fairness_metrics_after,
    bias_flags_before, bias_flags_after,
    risk_score, risk_label, risk_score_after, risk_label_after,
    accuracy_before, accuracy_after,
    group_metrics_before, group_metrics_after,
    fairness_before, fairness_after,
    bias_level, bias_detected,
    message, insights,
    total_rows, feature_columns,
    debiased_dataset, debiased_model, intersectional,
    strategy, model_type,
  } = result

  const accuracyDiff = (accuracy_after - accuracy_before).toFixed(1)
  const riskDiff = (risk_score_after - risk_score).toFixed(1)

  function metricColor(val) {
    return val > 0 ? 'var(--green)' : val === 0 ? 'var(--text-muted)' : 'var(--amber)'
  }
  function riskDiffColor(val) {
    return val < 0 ? 'var(--green)' : val === 0 ? 'var(--text-muted)' : 'var(--red)'
  }

  async function handleShare() {
    const url = buildShareUrl({ type: 'audit', result, targetColumn, sensitiveColumn })
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setShareState('copied')
      setTimeout(() => setShareState('idle'), 2500)
    } catch { setShareState('error') }
  }

  async function handleExportPdf() {
    setExporting(true)
    try { await exportAuditToPdf(result, targetColumn, sensitiveColumn) }
    finally { setExporting(false) }
  }

  function handleReset() {
    if (standalone) navigate('/')
    else onReset?.()
  }

  const shareLabel = { idle: 'Share', copied: '✓ Copied!', error: 'Failed' }[shareState]

  const flaggedCount = Object.values(bias_flags_before || {}).filter(Boolean).length
  const flaggedAfterCount = Object.values(bias_flags_after || {}).filter(Boolean).length

  return (
    <div className={styles.wrapper}>
      {/* Header */}
      <div className={styles.header}>
        <div>
          <h3 className={styles.title}>
            Dataset Audit Results
            {intersectional && <span className={styles.badge}>Intersectional</span>}
            <span className={styles.badge} style={{ background: 'rgba(79,142,247,0.1)', color: 'var(--accent)' }}>
              {MODEL_LABELS[model_type] || model_type}
            </span>
            <span className={styles.badge} style={{ background: 'rgba(167,139,250,0.1)', color: '#a78bfa' }}>
              {STRATEGY_LABELS[strategy] || strategy}
            </span>
          </h3>
          <p className={styles.subtitle}>
            {total_rows} rows · {feature_columns.length} features ·
            Target: <b>{targetColumn}</b> · Sensitive: <b>{sensitiveColumn}</b>
          </p>
        </div>
        <div className={styles.headerActions}>
          <button className={`${styles.actionBtn} ${shareState === 'copied' ? styles.actionSuccess : ''}`}
            onClick={handleShare}>{shareLabel}</button>
          <button className={styles.actionBtn} onClick={handleExportPdf} disabled={exporting}>
            {exporting ? 'Exporting…' : 'PDF'}
          </button>
          <button className={styles.actionBtn} onClick={() => downloadBase64File(debiased_dataset, 'fairlens_debiased_dataset.csv', 'text/csv')}
            disabled={!debiased_dataset}>⬇ Dataset</button>
          <button className={styles.actionBtn} onClick={() => downloadBase64File(debiased_model, 'fairlens_debiased_model.pkl', 'application/octet-stream')}
            disabled={!debiased_model}>⬇ Model</button>
          <button className={styles.resetBtn} onClick={handleReset}>← New Audit</button>
        </div>
      </div>

      {/* Bias banner */}
      <div className={`${styles.banner} ${styles[`banner${bias_level}`]}`}>
        {bias_detected
          ? `⚠ ${bias_level} bias detected (${flaggedCount}/5 metrics flagged before mitigation, ${flaggedAfterCount}/5 after). Risk score: ${risk_score} → ${risk_score_after}.`
          : `✓ Low bias detected. ${flaggedCount}/5 metrics flagged. The model appears broadly fair.`}
      </div>

      {/* Tabs */}
      <div className={styles.tabs}>
        {['overview', 'metrics', 'groups', 'insights'].map(tab => (
          <button key={tab} className={`${styles.tab} ${activeTab === tab ? styles.tabActive : ''}`}
            onClick={() => setActiveTab(tab)}>
            {tab === 'overview' && 'Overview'}
            {tab === 'metrics' && 'Metrics'}
            {tab === 'groups' && 'Groups'}
            {tab === 'insights' && 'Insights'}
          </button>
        ))}
      </div>

      {/* ── OVERVIEW TAB ── */}
      {activeTab === 'overview' && (
        <>
          {/* Risk gauges row */}
          <div className={styles.gaugesRow}>
            <div className={styles.card}>
              <p className={styles.cardLabel}>Fairness Risk — Before</p>
              <RiskGauge score={risk_score} label={risk_label} />
            </div>
            <div className={styles.arrowCol}>→</div>
            <div className={styles.card}>
              <p className={styles.cardLabel}>Fairness Risk — After Mitigation</p>
              <RiskGauge score={risk_score_after} label={risk_label_after} />
            </div>
          </div>

          {/* Quick metrics */}
          <div className={styles.metricsGrid}>
            {[
              { label: 'Model Accuracy', before: `${accuracy_before}%`, after: `${accuracy_after}%`,
                diff: `${accuracyDiff > 0 ? '+' : ''}${accuracyDiff}%`, diffVal: parseFloat(accuracyDiff) },
              { label: 'Risk Score', before: `${risk_score}`, after: `${risk_score_after}`,
                diff: `${riskDiff > 0 ? '+' : ''}${riskDiff}`, diffVal: -parseFloat(riskDiff),
                diffFn: riskDiffColor },
              { label: 'DPD', before: fairness_metrics_before?.demographic_parity_difference?.toFixed(4),
                after: fairness_metrics_after?.demographic_parity_difference?.toFixed(4),
                diff: fairness_metrics_after?.demographic_parity_difference < fairness_metrics_before?.demographic_parity_difference ? '↓ Better' : '↑ Worse',
                diffVal: fairness_metrics_before?.demographic_parity_difference - fairness_metrics_after?.demographic_parity_difference },
              { label: 'Disparate Impact', before: fairness_metrics_before?.disparate_impact_ratio?.toFixed(4),
                after: fairness_metrics_after?.disparate_impact_ratio?.toFixed(4),
                diff: fairness_metrics_after?.disparate_impact_ratio > fairness_metrics_before?.disparate_impact_ratio ? '↑ Better' : '↓ Worse',
                diffVal: fairness_metrics_after?.disparate_impact_ratio - fairness_metrics_before?.disparate_impact_ratio },
            ].map(m => (
              <div key={m.label} className={styles.metricCard}>
                <p className={styles.metricLabel}>{m.label}</p>
                <div className={styles.metricRow}>
                  <span className={styles.metricVal}>{m.before}</span>
                  <span className={styles.metricArrow}>→</span>
                  <span className={styles.metricVal}>{m.after}</span>
                  <span className={styles.metricDiff} style={{ color: metricColor(m.diffVal) }}>
                    {m.diff}
                  </span>
                </div>
              </div>
            ))}
          </div>

          {/* Selection rate chart */}
          <div className={styles.card} style={{ alignItems: 'stretch' }}>
            <FairnessComparisonChart
              groupMetricsBefore={group_metrics_before}
              groupMetricsAfter={group_metrics_after}
            />
          </div>
        </>
      )}

      {/* ── METRICS TAB ── */}
      {activeTab === 'metrics' && (
        <div className={styles.card} style={{ alignItems: 'stretch' }}>
          <h4 className={styles.sectionTitle}>All Fairness Metrics — Before vs After</h4>
          <MetricsTable
            metricsBefore={fairness_metrics_before}
            metricsAfter={fairness_metrics_after}
            flagsBefore={bias_flags_before}
            flagsAfter={bias_flags_after}
          />
        </div>
      )}

      {/* ── GROUPS TAB ── */}
      {activeTab === 'groups' && (
        <>
          <div className={styles.card} style={{ alignItems: 'stretch' }}>
            <RadarChart groupMetrics={group_metrics_before} title="Per-Group Metrics Radar (Before)" />
          </div>
          <div className={styles.card} style={{ alignItems: 'stretch' }}>
            <h4 className={styles.sectionTitle}>Per-Group Metrics — After Mitigation</h4>
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Group</th><th>Count</th><th>Selection Rate</th>
                    <th>Accuracy</th><th>TPR</th><th>FPR</th><th>Precision</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(group_metrics_after).map(([group, m]) => (
                    <tr key={group}>
                      <td><strong>{group}</strong></td>
                      <td>{m.count}</td>
                      <td>{(m.selection_rate * 100).toFixed(1)}%</td>
                      <td>{(m.accuracy * 100).toFixed(1)}%</td>
                      <td>{(m.tpr * 100).toFixed(1)}%</td>
                      <td>{(m.fpr * 100).toFixed(1)}%</td>
                      <td>{(m.precision * 100).toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ── INSIGHTS TAB ── */}
      {activeTab === 'insights' && (
        <>
          <div className={styles.messageCard}>
            <div className={styles.messageHeader}>
              <Icon name='robot' size={16}/>
              <span className={styles.messageLabel}>Gemini 2.5 Flash Audit Report</span>
            </div>
            <p className={styles.messageText}>{message}</p>
          </div>

          {insights?.length > 0 && (
            <div className={styles.card} style={{ alignItems: 'stretch' }}>
              <h4 className={styles.sectionTitle}>Key Insights</h4>
              <div className={styles.insightsList}>
                {insights.map((insight, i) => (
                  <div key={i} className={styles.insightItem}>
                    <span className={styles.insightNum}>{i + 1}</span>
                    <p>{insight}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
