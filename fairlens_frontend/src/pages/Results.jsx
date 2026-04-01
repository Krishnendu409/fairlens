import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useEffect, useState } from 'react'
import BiasGauge from '../components/BiasGauge'
import CategoryChart from '../components/CategoryChart'
import ExplanationPanel from '../components/ExplanationPanel'
import RewritePanel from '../components/RewritePanel'
import HistoryPanel from '../components/HistoryPanel'
import TrendChart from '../components/TrendChart'
import PageHeader from '../components/PageHeader'
import { buildShareUrl, decodeShareData } from '../api/share'
import { exportToPdf, exportToPdfBlob } from '../api/exportPdf'
import Icon from '../components/Icon'
import styles from './Results.module.css'

export default function Results() {
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [shareState, setShareState] = useState('idle')
  const [showHistory, setShowHistory] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [pdfPreviewUrl, setPdfPreviewUrl] = useState('')

  const sharedParam = searchParams.get('shared')
  let stateData = location.state
  if (!stateData && sharedParam) {
    const decoded = decodeShareData(sharedParam)
    if (decoded) stateData = decoded
  }

  const { result, prompt, aiResponse } = stateData || {}
  useEffect(() => { if (!result) navigate('/', { replace: true }) }, [result, navigate])
  if (!result) return null

  async function handleShare() {
    const url = buildShareUrl({ result, prompt, aiResponse })
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setShareState('copied')
      setTimeout(() => setShareState('idle'), 2500)
    } catch { setShareState('error') }
  }

  async function handleExportPdf() {
    setExporting(true)
    try { await exportToPdf(prompt, aiResponse, result) }
    finally { setExporting(false) }
  }
  async function handlePreviewPdf() {
    const blob = await exportToPdfBlob(prompt, aiResponse, result)
    const nextUrl = URL.createObjectURL(blob)
    setPdfPreviewUrl(prev => {
      if (prev) URL.revokeObjectURL(prev)
      return nextUrl
    })
  }

  const shareLabel = { idle: 'Share', copied: 'Copied!', error: 'Failed' }[shareState]
  const fairnessGrade = result.bias_score < 20 ? 'A' : result.bias_score < 35 ? 'B' : result.bias_score < 50 ? 'C' : result.bias_score < 70 ? 'D' : 'F'

  return (
    <div className={styles.page}>
      <PageHeader
        onBack={() => navigate('/')}
        actions={[
          { label: 'History', onClick: () => setShowHistory(true) },
          { label: shareLabel, onClick: handleShare, success: shareState === 'copied' },
          { label: 'Preview PDF', onClick: handlePreviewPdf },
          { label: exporting ? 'Exporting…' : 'PDF', onClick: handleExportPdf, disabled: exporting },
        ]}
      />

      <main className={styles.main}>
        <div className={`${styles.banner} ${styles[`banner${result.bias_level}`]}`}>
          {result.bias_level === 'Low' && '✓ Low bias detected. This response appears mostly fair.'}
          {result.bias_level === 'Moderate' && 'Moderate bias detected. Review the analysis below.'}
          {result.bias_level === 'High' && 'High bias detected. See the corrected version below.'}
          {result.bias_level === 'Critical' && '⚠ Critical bias detected. Significant fairness intervention required before deployment.'}
        </div>

        <div className={styles.topRow}>
          <div className={styles.card}>
            <p className={styles.cardTitle}>Overall Bias Score</p>
            <div className={styles.gaugeWrapper}>
              <BiasGauge score={result.bias_score} level={result.bias_level} confidence={result.confidence} />
            </div>
            <p className={styles.gaugeHint}>
              Fairness Grade: <strong>{fairnessGrade}</strong><br />
              {result.bias_level === 'Low' && 'Minimal bias detected.'}
              {result.bias_level === 'Moderate' && 'Notable bias that could affect some groups.'}
              {result.bias_level === 'High' && 'Significant bias. Review the unbiased rewrite.'}
              {result.bias_level === 'Critical' && 'Critical bias. Deployment blocked pending remediation.'}
            </p>
          </div>
          <div className={`${styles.card} ${styles.chartCard}`}>
            <p className={styles.cardTitle}>Bias by Dimension</p>
            <CategoryChart categories={result.categories} />
          </div>
        </div>

        <div className={styles.card}>
          <TrendChart />
          {JSON.parse(localStorage.getItem('fairlens_history') || '[]').length < 2 && (
            <p className={styles.trendHint}>Run more analyses to see your bias score trend.</p>
          )}
        </div>

        <div className={styles.card}>
          <p className={styles.cardTitle}>Root Cause Analysis</p>
          <ExplanationPanel explanation={result.explanation} flaggedPhrases={result.flagged_phrases} />
        </div>

        <div className={styles.card}>
          <p className={styles.cardTitle}>Original vs. Unbiased Rewrite</p>
          <RewritePanel original={aiResponse} unbiased={result.unbiased_response} flaggedPhrases={result.flagged_phrases} />
        </div>

        <div className={styles.card}>
          <p className={styles.cardTitle}>Original Prompt</p>
          <p className={styles.promptText}>{prompt}</p>
        </div>

        {pdfPreviewUrl && (
          <div className={styles.card}>
            <p className={styles.cardTitle}>PDF Preview</p>
            <iframe title="PDF preview" src={pdfPreviewUrl} style={{ width: '100%', minHeight: '480px', border: '1px solid var(--border)', borderRadius: '8px' }} />
          </div>
        )}
      </main>

      <footer className={styles.footer}>
        Built by Team Triple A · Solution Challenge 2026 · Powered by Gemini 2.5 Flash
      </footer>

      {showHistory && <HistoryPanel onClose={() => setShowHistory(false)} />}
    </div>
  )
}
