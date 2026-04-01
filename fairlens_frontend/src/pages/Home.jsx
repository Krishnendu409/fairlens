import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { analyseText } from '../api/fairlens'
import { auditDataset, parseCsvHeaders, sampleAudit } from '../api/audit'
import { saveToHistory, saveToAuditHistory, generateId, getHistory, getAuditHistory } from '../api/history'
import DatasetUpload from '../components/DatasetUpload'
import HistoryPanel from '../components/HistoryPanel'
import AuditHistoryPanel from '../components/AuditHistoryPanel'
import TrendChart from '../components/TrendChart'
import ThemeToggle from '../components/ThemeToggle'
import Icon from '../components/Icon'
import styles from './Home.module.css'

export default function Home() {
  const navigate = useNavigate()
  const [mode, setMode] = useState('dataset')

  // Text
  const [prompt, setPrompt] = useState('')
  const [aiResponse, setAiResponse] = useState('')
  const [textLoading, setTextLoading] = useState(false)
  const [textError, setTextError] = useState('')

  // Audit — new simplified flow
  const [csvFile, setCsvFile] = useState(null)
  const [columns, setColumns] = useState([])
  const [description, setDescription] = useState('')
  const [targetCol, setTargetCol] = useState('')
  const [sensitiveCol, setSensitiveCol] = useState('')
  const [sensitiveCol2, setSensitiveCol2] = useState('')
  const [auditLoading, setAuditLoading] = useState(false)
  const [auditError, setAuditError] = useState('')
  const [descFocused, setDescFocused] = useState(false)
  const [privacyMode, setPrivacyMode] = useState(true)

  // Shared
  const [showTextHistory, setShowTextHistory] = useState(false)
  const [showAuditHistory, setShowAuditHistory] = useState(false)
  const textHistoryCount = getHistory().length
  const auditHistoryCount = getAuditHistory().length

  async function handleAnalyse() {
    if (!prompt.trim() || !aiResponse.trim()) { setTextError('Please fill in both fields.'); return }
    setTextError(''); setTextLoading(true)
    try {
      const result = await analyseText(prompt.trim(), aiResponse.trim())
      saveToHistory({ id: generateId(), timestamp: Date.now(), prompt: prompt.trim(), aiResponse: aiResponse.trim(), result })
      navigate('/results', { state: { result, prompt: prompt.trim(), aiResponse: aiResponse.trim() } })
    } catch (err) {
      setTextError(`Analysis failed: ${err?.response?.data?.detail || err.message}`)
    } finally { setTextLoading(false) }
  }

  function loadExample() {
    setPrompt("Who makes a better leader, a man or a woman?")
    setAiResponse("Men tend to make better leaders because they are more decisive, assertive, and less emotional in high-pressure situations. Women are naturally more suited to supportive roles.")
    setTextError('')
  }

  async function handleFileSelected(file) {
    setCsvFile(file); setAuditError('')
    try {
      const headers = await parseCsvHeaders(file)
      setColumns(headers)
      setTargetCol(''); setSensitiveCol(''); setSensitiveCol2('')
    } catch { setAuditError('Could not read CSV headers.') }
  }

  function loadExampleDescription() {
    setDescription('This is a dataset of student marks in 4 subjects (Maths, English, Science, History) for grades 1 to 13, with 10 students per grade. Maths and English are graded by Teacher A, Science by Teacher B, and History by Teacher C. The passing threshold is 80 marks. The dataset includes student name, gender (Male/Female), grade level, subject, marks obtained, and pass/fail status.')
  }

  async function handleAudit() {
    if (!csvFile) { setAuditError('Please upload a CSV file.'); return }
    if (!description.trim()) { setAuditError('Please describe your dataset — this helps AI understand context.'); return }
    setAuditError(''); setAuditLoading(true)
    try {
      const result = await auditDataset({
        file: csvFile,
        description: description.trim(),
        targetColumn: targetCol || null,
        sensitiveColumn: sensitiveCol || null,
        sensitiveColumn2: sensitiveCol2 || null,
        privacyMode,
      })
      saveToAuditHistory({ id: generateId(), timestamp: Date.now(), description: description.trim(), result })
      navigate('/audit-results', { state: { result, description: description.trim() } })
    } catch (err) {
      setAuditError(`Audit failed: ${err?.response?.data?.detail || err.message}`)
    } finally { setAuditLoading(false) }
  }

  function handleAuditHistoryOpen(entry) {
    navigate('/audit-results', { state: { result: entry.result, description: entry.description || '' } })
  }

  async function runSample(datasetName) {
    setAuditError('')
    setAuditLoading(true)
    try {
      const result = await sampleAudit(datasetName)
      saveToAuditHistory({ id: generateId(), timestamp: Date.now(), description: `Sample: ${datasetName}`, result })
      navigate('/audit-results', { state: { result, description: `Sample: ${datasetName}` } })
    } catch (err) {
      setAuditError(`Sample audit failed: ${err?.response?.data?.detail || err.message}`)
    } finally {
      setAuditLoading(false)
    }
  }

  const canRunAudit = csvFile && description.trim().length > 10

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.logoArea}>
          <img src="/fairlens_logo.png" alt="FairLens" className={styles.logoImg} />
        </div>
        <div className={styles.headerRight}>
          <ThemeToggle />
          {mode === 'dataset' ? (
            <button className={styles.historyBtn} onClick={() => setShowAuditHistory(true)}>
              <Icon name='chart' size={14}/> History {auditHistoryCount > 0 && <span className={styles.historyBadge}>{auditHistoryCount}</span>}
            </button>
          ) : (
            <button className={styles.historyBtn} onClick={() => setShowTextHistory(true)}>
              <Icon name='history' size={14}/> History {textHistoryCount > 0 && <span className={styles.historyBadge}>{textHistoryCount}</span>}
            </button>
          )}
        </div>
      </header>

      <p className={styles.tagline}>Detect hidden bias in any AI response or dataset — instantly.</p>

      <main className={styles.main}>
        <div className={styles.modeToggle}>
          <button className={`${styles.modeBtn} ${mode === 'dataset' ? styles.modeBtnActive : ''}`}
            onClick={() => setMode('dataset')}>
            <Icon name='chart' size={16}/> Dataset Fairness Audit
          </button>
          <button className={`${styles.modeBtn} ${mode === 'text' ? styles.modeBtnActive : ''}`}
            onClick={() => setMode('text')}>
            <Icon name='chat' size={16}/> Text Bias Analysis
          </button>
        </div>

        {/* ── DATASET MODE ── */}
        {mode === 'dataset' && (
          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <h2>Upload a dataset to audit for bias</h2>
            </div>

            <div className={styles.auditSteps}>
              {/* Step 1: Upload */}
              <div className={styles.stepRow}>
                <div className={styles.stepNum}>1</div>
                <div className={styles.stepContent}>
                  <p className={styles.stepLabel}>Upload CSV Dataset</p>
                  <DatasetUpload onFileSelected={handleFileSelected} file={csvFile} />
                  {columns.length > 0 && (
                    <p className={styles.columnsHint}>
                      Detected columns: {columns.join(', ')}
                    </p>
                  )}
                </div>
              </div>

              {/* Step 2: Describe */}
              <div className={`${styles.stepRow} ${!csvFile ? styles.stepDisabled : ''}`}>
                <div className={styles.stepNum}>2</div>
                <div className={styles.stepContent}>
                  <div className={styles.descLabelRow}>
                    <p className={styles.stepLabel}>Describe your dataset</p>
                    <button className={styles.exampleBtn} onClick={loadExampleDescription} disabled={!csvFile}>
                      Load example
                    </button>
                  </div>
                  <p className={styles.stepHint}>
                    Tell FairLens what this data represents — who collected it, what each column means, what the grading system or thresholds are, who the teachers/evaluators are, etc. The more context you give, the better the AI analysis.
                  </p>
                  <div className={`${styles.descBox} ${descFocused ? styles.descBoxFocused : ''} ${!csvFile ? styles.descBoxDisabled : ''}`}>
                    <textarea
                      className={styles.descTextarea}
                      value={description}
                      onChange={e => setDescription(e.target.value)}
                      onFocus={() => setDescFocused(true)}
                      onBlur={() => setDescFocused(false)}
                      disabled={!csvFile}
                      placeholder="e.g. This is a student marks dataset for grades 1–13 with 10 students per grade. There are 4 subjects — Maths and English graded by Teacher A, Science by Teacher B, and History by Teacher C. Pass threshold is 80. Gender column has Male/Female values..."
                      rows={5}
                    />
                    <div className={styles.descFooter}>
                      <span className={styles.descCount}>{description.length} characters</span>
                      {description.length > 0 && description.length < 50 && (
                        <span className={styles.descWarn}>⚠ Add more detail for better analysis</span>
                      )}
                      {description.length >= 50 && (
                        <span className={styles.descOk}>✓ Good description</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Step 3: Optional columns */}
              <div className={`${styles.stepRow} ${(!csvFile || !description.trim()) ? styles.stepDisabled : ''}`}>
                <div className={styles.stepNum}>3</div>
                <div className={styles.stepContent}>
                  <p className={styles.stepLabel}>Optional: Specify columns <span className={styles.optionalTag}>optional</span></p>
                  <p className={styles.stepHint}>
                    If you mention your sensitive attribute and target column in the description, FairLens AI will auto-detect them. Or specify them explicitly below.
                  </p>
                  {columns.length > 0 && (
                    <div className={styles.colSelectors}>
                      <div className={styles.colSel}>
                        <label className={styles.colLabel}>Outcome column (what to measure fairness on)</label>
                        <select className={styles.colSelect} value={targetCol}
                          onChange={e => setTargetCol(e.target.value)}
                          disabled={!csvFile || !description.trim()}>
                          <option value="">— Auto-detect from description —</option>
                          {columns.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </div>
                      <div className={styles.colSel}>
                        <label className={styles.colLabel}>Protected attribute (e.g. Gender, Region, Race)</label>
                        <select className={styles.colSelect} value={sensitiveCol}
                          onChange={e => setSensitiveCol(e.target.value)}
                          disabled={!csvFile || !description.trim()}>
                          <option value="">— Auto-detect from description —</option>
                          {columns.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Step 4: Run */}
              <div className={`${styles.stepRow} ${!canRunAudit ? styles.stepDisabled : ''}`}>
                <div className={styles.stepNum}>4</div>
                <div className={styles.stepContent}>
                  <p className={styles.stepLabel}>Run AI Fairness Audit</p>
                  <p className={styles.stepHint}>
                    FairLens sends your dataset statistics and description to Gemini 2.5 Flash. It computes fairness metrics, detects bias patterns, and returns a structured audit report with findings, charts, and recommendations.
                  </p>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, color: 'var(--text-muted)' }}>
                    <input type="checkbox" checked={privacyMode} onChange={e => setPrivacyMode(e.target.checked)} />
                    Privacy mode (no external API call, no server-side audit persistence)
                  </label>
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <button className={styles.exampleBtn} type="button" onClick={() => runSample('compas')} disabled={auditLoading}>Sample: COMPAS</button>
                    <button className={styles.exampleBtn} type="button" onClick={() => runSample('adult_income')} disabled={auditLoading}>Sample: Adult Income</button>
                  </div>
                </div>
              </div>
            </div>

            {auditError && <p className={styles.error}>{auditError}</p>}
            <button className={styles.analyseBtn} onClick={handleAudit}
              disabled={auditLoading || !canRunAudit}>
              {auditLoading
                ? <><span className={styles.spinner} />Analysing with Gemini 2.5 Flash...</>
                : 'Run Fairness Audit'}
            </button>
          </div>
        )}

        {/* ── TEXT MODE ── */}
        {mode === 'text' && (
          <>
            <TrendChart />
            <div className={styles.card}>
              <div className={styles.cardHeader}>
                <h2>Paste your AI prompt &amp; response</h2>
                <button className={styles.exampleBtn} onClick={loadExample}>Load example</button>
              </div>
              <div className={styles.inputGrid}>
                <div className={styles.inputGroup}>
                  <label htmlFor="prompt">
                    <span className={styles.labelDot} style={{ background: 'var(--primary)' }} />
                    Your Prompt
                  </label>
                  <textarea id="prompt" className={styles.textarea}
                    placeholder="e.g. Who makes a better leader?"
                    value={prompt} onChange={e => setPrompt(e.target.value)} rows={8} />
                  <span className={styles.charCount}>{prompt.length} chars</span>
                </div>
                <div className={styles.inputGroup}>
                  <label htmlFor="aiResponse">
                    <span className={styles.labelDot} style={{ background: 'var(--red)' }} />
                    AI Response to Analyse
                  </label>
                  <textarea id="aiResponse" className={styles.textarea}
                    placeholder="Paste the AI's response here..."
                    value={aiResponse} onChange={e => setAiResponse(e.target.value)} rows={8} />
                  <span className={styles.charCount}>{aiResponse.length} chars</span>
                </div>
              </div>
              {textError && <p className={styles.error}>{textError}</p>}
              <button className={styles.analyseBtn} onClick={handleAnalyse} disabled={textLoading}>
                {textLoading ? <><Icon name='spinner' size={14} style={{animation:'spin 1s linear infinite'}}/> Analysing with Gemini 2.5 Flash...</> : <><Icon name='analyse' size={14}/> Analyse for Bias</>}
              </button>
            </div>
          </>
        )}

        {/* How it works */}
        <div className={styles.howItWorks}>
          <h3>How FairLens works</h3>
          <div className={styles.steps}>
            {(mode === 'dataset' ? [
              { icon: 'upload', title: 'Upload', desc: 'Upload any CSV dataset' },
              { icon: 'describe', title: 'Describe', desc: 'Explain your dataset in plain English' },
              { icon: 'robot', title: 'Analyse', desc: 'Gemini reads stats and detects bias' },
              { icon: 'chart', title: 'Report', desc: 'Full report with charts + chat' },
            ] : [
              { icon: 'text', title: 'Paste', desc: 'Enter any AI prompt and response' },
              { icon: 'robot', title: 'Analyse', desc: 'Gemini 2.5 Flash scans for bias' },
              { icon: 'metrics', title: 'Score', desc: 'Bias score across 6 dimensions' },
              { icon: 'fix', title: 'Fix', desc: 'Unbiased rewrite instantly' },
            ]).map(s => (
              <div key={s.title} className={styles.stepCard}>
                <div className={styles.stepCardIcon}><Icon name={s.icon} size={20}/></div>
                <strong>{s.title}</strong>
                <p>{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </main>

      <footer className={styles.footer}>
        Built by Team Triple A · Solution Challenge 2026 · Powered by Gemini 2.5 Flash
      </footer>

      {showTextHistory && <HistoryPanel onClose={() => setShowTextHistory(false)} />}
      {showAuditHistory && <AuditHistoryPanel onClose={() => setShowAuditHistory(false)} onOpen={handleAuditHistoryOpen} />}
    </div>
  )
}
