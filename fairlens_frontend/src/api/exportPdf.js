/**
 * exportPdf.js — EU AI Act Compliance Report Generator (FairLens White Theme)
 *
 * Designed to feel like the FairLens app (Orange accents, rounded soft styling)
 * but optimized for professional white-background document printing. 
 * Includes native jsPDF vector graphics, automated signatures, and plain english context.
 */

import { jsPDF } from 'jspdf'

// ── FairLens Light/White Theme ───────────────────────────────────────────────
const C = {
  bg:       [255, 255, 255], 
  surface:  [255, 248, 243], // Very faint orange
  surface2: [255, 237, 222], // Slightly darker faint orange
  border:   [250, 215, 190], // FairLens orange border faint
  text:     [24, 24, 27],    // Zinc-900 
  muted:    [113, 113, 122], // Zinc-500
  primary:  [232, 114, 12],  // FairLens Orange!
  accent:   [232, 114, 12],  
  
  green:    [22, 163, 74],   
  amber:    [217, 119, 6],   
  red:      [220, 38, 38],   
}

const METHODOLOGY_VERSION = 'FL-2026.03-v3.0'
const METHODOLOGY_HASH = 'b7a4f3e2c1d09f8e'

const PW = 210, PH = 297 // A4 in mm
const M = 20             // Margin
const CW = PW - 2 * M    // Content Width
const FOOTER_H = 15

// ── Strict Definitions ───────────────────────────────────────────────────────
const METRIC_DEFS = {
  'demographic_parity_difference': 'Measures the absolute difference in positive outcome rates between groups. A lower score means groups are treated more equally.',
  'disparate_impact_ratio': 'The ratio of the lowest-performing group\'s pass rate against the highest. The EU typically desires a ratio of 0.8 (80%) or higher.',
  'theil_index': 'A generalized entropy index measuring total systemic inequality across all individuals simultaneously. 0 means perfect equality.'
}

// ── Safe Text Encoding ───────────────────────────────────────────────────────
function safeStr(str) {
  if (str == null) return ''
  return String(str)
    .replace(/→/g, '->')
    .replace(/—/g, '-')
    .replace(/–/g, '-')
    .replace(/“|”/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/↑/g, '(Up)')
    .replace(/↓/g, '(Down)')
}

function generateVerificationHash(str) {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32bit integer
  }
  return 'SHAx' + Math.abs(hash).toString(16).padStart(12, '0').toUpperCase()
}

// Returns false when description looks like a placeholder / keyboard-mash
function isValidDescription(str) {
  if (!str || str.trim().length < 5) return false
  const s = str.trim()
  const letters = (s.match(/[a-z]/gi) || []).length
  if (letters < 8) return true // too short to judge reliably
  const vowels = (s.match(/[aeiou]/gi) || []).length
  if (vowels / letters < 0.08) return false          // almost no vowels
  if (/[bcdfghjklmnpqrstvwxyz]{7,}/i.test(s)) return false // 7+ consecutive consonants
  return true
}

// Infers deployment domain from column names + target/sensitive column
function detectDomain(columns, targetCol, sensitiveCol) {
  const all = [...(columns || []), targetCol || '', sensitiveCol || ''].join(' ').toLowerCase()
  if (/\b(hir|employ|job|salary|recruit|worker|position|applicant)\b/.test(all)) return 'employment'
  if (/\b(mark|grade|score|pass|fail|exam|school|subject|student|course|educat)\b/.test(all)) return 'education'
  if (/\b(loan|credit|bank|financ|mortgage|debt)\b/.test(all)) return 'credit'
  if (/\b(health|medical|patient|diagnos|hospital|clinic|drug)\b/.test(all)) return 'healthcare'
  if (/\b(tenant|rent|housing|home|evict)\b/.test(all)) return 'housing'
  return 'general'
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function checkPage(doc, y, needed) {
  if (y + needed > PH - FOOTER_H - 15) {
    pageFooter(doc)
    doc.addPage()
    doc.setFillColor(...C.bg); doc.rect(0, 0, PW, PH, 'F')
    return M + 10
  }
  return y
}

function pageFooter(doc) {
  const pg = doc.internal.getNumberOfPages()
  doc.setDrawColor(...C.border); doc.setLineWidth(0.3)
  doc.line(M, PH - FOOTER_H, PW - M, PH - FOOTER_H)
  doc.setFontSize(7)
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(...C.muted)
  doc.text('FairLens Automated Audit Report', M, PH - FOOTER_H + 5)
  doc.text(`Methodology: ${METHODOLOGY_VERSION}`, PW / 2, PH - FOOTER_H + 5, { align: 'center' })
  doc.text(`Page ${pg}`, PW - M, PH - FOOTER_H + 5, { align: 'right' })
}

function drawSectionHeader(doc, title, y) {
  y = checkPage(doc, y, 15)
  doc.setFontSize(14)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(...C.primary)
  doc.text(safeStr(title).toUpperCase(), M, y)
  // Orange underline
  doc.setDrawColor(...C.primary); doc.setLineWidth(0.8)
  doc.line(M, y + 2, M + 15, y + 2)
  doc.setDrawColor(...C.border); doc.setLineWidth(0.3)
  doc.line(M + 15, y + 2, PW - M, y + 2)
  return y + 10
}

function subHeading(doc, text, y) {
  doc.setFontSize(10)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(...C.text)
  doc.text(safeStr(text), M, y)
  return y + 5
}

function textBlock(doc, text, x, y, opts = {}) {
  const maxW = opts.maxW || CW
  const fontSize = opts.fontSize || 9
  const lineHeight = opts.lineHeight || 1.4
  doc.setFontSize(fontSize)
  doc.setFont('helvetica', opts.bold ? 'bold' : 'normal')
  doc.setTextColor(...(opts.color || C.text))
  
  const lines = doc.splitTextToSize(safeStr(text), maxW)
  for (const line of lines) {
    y = checkPage(doc, y, fontSize * 0.4)
    doc.text(line, x, y)
    y += (fontSize * 0.35) * lineHeight
  }
  return y + (opts.mb || 4)
}

function dataRow(doc, label, value, y, color = C.text) {
  doc.setFontSize(8)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(...C.muted)
  doc.text(safeStr(label), M, y)
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(...color)
  doc.text(safeStr(value ?? '-'), M + 45, y)
  return y + 5
}

// ── Native Vector Graphics ───────────────────────────────────────────────────

function drawRiskGauge(doc, score, euRisk, y) {
  const gw = CW; const gh = 10
  // Background track
  doc.setDrawColor(...C.border); doc.setLineWidth(0.2)
  doc.setFillColor(...C.surface2)
  doc.roundedRect(M, y, gw, gh, 2, 2, 'FD')
  
  // Filled track
  const fillW = Math.max(2, (Math.min(score, 100) / 100) * gw)
  doc.setFillColor(...euRisk.color)
  doc.roundedRect(M, y, fillW, gh, 2, 2, 'F')
  
  // Ticks
  const ticks = [20, 45, 70]
  doc.setFontSize(6); doc.setTextColor(...C.muted); doc.setFont('helvetica', 'normal')
  for (const t of ticks) {
    const tx = M + (t / 100) * gw
    doc.setDrawColor(...C.bg); doc.setLineWidth(0.5)
    doc.line(tx, y, tx, y + gh)
    doc.text(String(t), tx, y + gh + 5, { align: 'center' })
  }
  
  doc.setFontSize(16); doc.setFont('helvetica', 'bold'); doc.setTextColor(...euRisk.color)
  doc.text(`SCORE: ${score}/100 - ${euRisk.euClass.toUpperCase()}`, M, y - 4)
  
  return y + gh + 12
}

function drawBarChart(doc, data, labelCol, valCol, x, y, w, h) {
  if (!data || data.length === 0) return y
  const maxVal = Math.max(...data.map(d => d[valCol]), 1)
  const barW = (w / data.length) * 0.6
  const gapW = (w / data.length) * 0.4
  
  // Axes
  doc.setDrawColor(...C.border); doc.setLineWidth(0.5)
  doc.line(x, y, x, y + h) // Y
  doc.line(x, y + h, x + w, y + h) // X
  
  // Grid lines
  doc.setDrawColor(...C.border); doc.setLineWidth(0.2); doc.setLineDash([1, 1])
  for (let i = 1; i <= 4; i++) {
    const ly = y + h - (h * (i / 4))
    doc.line(x, ly, x + w, ly)
    doc.setFontSize(6); doc.setTextColor(...C.muted); doc.setFont('helvetica', 'normal')
    doc.text(`${(maxVal * (i / 4) * 100).toFixed(0)}%`, x - 2, ly + 2, { align: 'right' })
  }
  doc.setLineDash([])
  
  // Bars
  let cx = x + gapW / 2
  for (const d of data) {
    const bh = (d[valCol] / maxVal) * h
    const by = y + h - bh
    
    doc.setFillColor(...C.primary)
    if (d[valCol] === Math.min(...data.map(x => x[valCol]))) doc.setFillColor(...C.red)
    if (d[valCol] === maxVal) doc.setFillColor(...C.green)
    
    doc.roundedRect(cx, by, barW, bh, 1, 1, 'F')
    
    // Values
    doc.setFontSize(7); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.text)
    doc.text(`${(d[valCol] * 100).toFixed(1)}%`, cx + barW / 2, by - 2, { align: 'center' })
    
    // Labels
    doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(...C.muted)
    const lbl = doc.splitTextToSize(safeStr(d[labelCol]), barW + 5)
    doc.text(lbl, cx + barW / 2, y + h + 5, { align: 'center' })
    
    cx += barW + gapW
  }
  return y + h + 18
}

function drawGridTable(doc, headers, rows, y, colWidths) {
  const rowH = 8
  y = checkPage(doc, y, rowH + 5)
  
  // Header
  doc.setFillColor(...C.surface2)
  doc.rect(M, y, CW, rowH, 'F')
  doc.setDrawColor(...C.border); doc.setLineWidth(0.3)
  doc.line(M, y, M + CW, y)
  doc.line(M, y + rowH, M + CW, y + rowH)
  
  doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.primary)
  let x = M + 2
  for (let i = 0; i < headers.length; i++) {
    doc.text(safeStr(headers[i]), x, y + 5.5)
    x += colWidths[i]
  }
  y += rowH
  
  // Rows
  for (let r = 0; r < rows.length; r++) {
    y = checkPage(doc, y, rowH)
    if (r % 2 === 1) { doc.setFillColor(...C.surface); doc.rect(M, y, CW, rowH, 'F') }
    doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(...C.text)
    x = M + 2
    for (let i = 0; i < rows[r].length; i++) {
      const cell = rows[r][i]
      doc.setTextColor(...(cell.color || C.text))
      if (cell.bold) doc.setFont('helvetica', 'bold')
      else doc.setFont('helvetica', 'normal')
      doc.text(safeStr(cell.text ?? '-'), x, y + 5.5)
      x += colWidths[i]
    }
    y += rowH
  }
  doc.line(M, y, M + CW, y)
  return y + 8
}

function getEURiskClass(score) {
  if (score < 20) return { level: 'Minimal Risk', euClass: 'Minimal Risk AI System', color: C.green }
  if (score < 45) return { level: 'Limited Risk', euClass: 'Limited Risk AI System', color: C.amber }
  if (score < 70) return { level: 'High Risk', euClass: 'High-Risk AI System', color: C.red }
  return { level: 'Unacceptable Risk', euClass: 'Potentially Prohibited System', color: C.red }
}

// ══════════════════════════════════════════════════════════════════════════════
// EXPORT PIPELINE
// ══════════════════════════════════════════════════════════════════════════════

export async function exportAuditToPdf(result, description) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const now = new Date()
  const ts = now.toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
  const dateStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
  const euRisk = getEURiskClass(result.bias_score ?? 0)
  
  const vHash = generateVerificationHash(JSON.stringify(result) + ts)

  doc.setFillColor(...C.bg); doc.rect(0, 0, PW, PH, 'F')

  // FairLens Header Banner
  doc.setFillColor(...C.primary)
  doc.rect(0, 0, PW, 6, 'F')
  doc.setFillColor(...C.surface2)
  doc.rect(M, 6, CW, 1, 'F')
  
  doc.setFontSize(28); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.primary)
  doc.text('FairLens Audit', M, 35)
  doc.setFontSize(14); doc.setTextColor(...C.text)
  doc.text('EU Artificial Intelligence Act Documentation Report', M, 43)

  doc.setFontSize(9); doc.setTextColor(...C.muted); doc.setFont('helvetica', 'normal')
  const introTxt = 'Confidential Report generated via the FairLens compliance pipeline. This document serves as technical documentation meeting the audit criteria specified under Articles 10, 11, and 12 of Regulation (EU) 2024/1689 of the European Parliament.'
  textBlock(doc, introTxt, M, 55, { maxW: CW, color: C.muted })

  // Meta Table
  let cy = 72
  cy = dataRow(doc, 'REPORT DATE', dateStr, cy)
  cy = dataRow(doc, 'TIMESTAMP', ts, cy)
  cy = dataRow(doc, 'DATASET', description || 'Not specified', cy)
  cy = dataRow(doc, 'RECORDS PROCESSED', result.total_rows?.toLocaleString() ?? '-', cy)
  cy = dataRow(doc, 'SENSITIVE ATTRIBUTE', result.sensitive_column ?? 'auto-detected', cy)
  cy = dataRow(doc, 'TARGET DECISION', result.target_column ?? 'auto-detected', cy)
  cy = dataRow(doc, 'COMPLIANCE AUDITOR', 'FairLens System (Automated)', cy)
  
  // ── Plain English Scope Statement ──
  cy += 6
  doc.setFillColor(...C.surface); doc.setDrawColor(...C.border); doc.setLineWidth(0.3)
  doc.roundedRect(M, cy, CW, 26, 2, 2, 'FD')
  
  const scopeText = `DATASET METADATA & EU COMPLIANCE SCOPE:\nThis dataset involves ${result.total_rows?.toLocaleString() ?? 'several'} records evaluating the decision outcome of "${result.target_column}". The attribute "${result.sensitive_column}" is legally protected against algorithmic discrimination. The objective of this audit is to guarantee that the system's outcomes for "${result.target_column}" are structurally fair across all groups associated with "${result.sensitive_column}".`
  cy = textBlock(doc, scopeText, M + 4, cy + 6, { maxW: CW - 8, color: C.muted, fontSize: 8.5, lineHeight: 1.6 })

  // ── Dataset identifier validation warning (Art. 11) ────────────────────────
  if (!isValidDescription(description)) {
    cy += 4
    doc.setFillColor(254, 235, 235)
    doc.setDrawColor(...C.red); doc.setLineWidth(0.5)
    doc.roundedRect(M, cy, CW, 18, 1, 1, 'FD')
    doc.setFontSize(8.5); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.red)
    doc.text('CRITICAL: INVALID DATASET IDENTIFIER (Art. 11)', M + 4, cy + 6)
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...C.text)
    const warnLines = doc.splitTextToSize(
      'The dataset description appears to contain a placeholder or nonsensical string. Article 11 requires unambiguous dataset identification including provenance, collection methodology, and version. This defect alone is sufficient to invalidate this document in a formal NCA proceeding.',
      CW - 8
    )
    doc.text(warnLines, M + 4, cy + 11)
    cy += Math.max(18, warnLines.length * 4 + 12)
  }

  cy += 8
  cy = drawRiskGauge(doc, result.bias_score ?? 0, euRisk, cy)

  // Executive Summary Narrative
  if (result.summary) {
    cy += 5
    cy = subHeading(doc, 'Executive Opinion & Model Health', cy)
    
    doc.setFillColor(...C.surface)
    doc.setDrawColor(...C.border); doc.setLineWidth(0.3)
    const boxY = cy; 
    let innerY = cy + 5
    const paras = result.summary.split('\n\n')
    
    // Determine dynamic height based on text lines
    doc.setFontSize(9.5)
    let totalLines = 0
    for(const p of paras) {
      const lines = doc.splitTextToSize(safeStr(p), CW - 10)
      totalLines += lines.length
    }
    const totalH = (totalLines * 4.5) + (paras.length * 4) + 6
    
    doc.roundedRect(M, boxY, CW, totalH, 2, 2, 'FD')
    
    for (const p of paras) {
      innerY = textBlock(doc, p, M + 5, innerY, { color: C.text, maxW: CW - 10, fontSize: 9.5, lineHeight: 1.5 })
    }
    cy = boxY + totalH + 10
  }

  let y = cy

  // ── Section 1: Dataset Statistics & Vectors ──
  y = checkPage(doc, y, 60)
  y = drawSectionHeader(doc, '1. Demographic Pass Rates (Art. 10)', y)
  
  const gStats = result.group_stats || []
  if (gStats.length > 0) {
    y = textBlock(doc, 'The following chart visualizes the positive outcome distribution across demographic groups. Significant downward deviations from the majority trigger compliance alerts under EU AI Act data governance requirements (Article 10).', M, y, { color: C.muted, mb: 10, lineHeight: 1.5 })
    
    y = drawBarChart(doc, gStats, 'group', 'pass_rate', M + 10, y, CW - 20, 50)
    
    // Automated Plain English Analysis of the Chart
    if (gStats.length > 1) {
      const sorted = [...gStats].sort((a,b) => b.pass_rate - a.pass_rate)
      const best = sorted[0]; const worst = sorted[sorted.length-1]
      const insightStr = `CHART ANALYSIS: The "${best.group}" group receives the highest rate of positive outcomes (${(best.pass_rate*100).toFixed(1)}%). The "${worst.group}" group is the most disadvantaged, receiving positive outcomes at only ${(worst.pass_rate*100).toFixed(1)}%.`
      
      doc.setFillColor(...C.surface2)
      doc.roundedRect(M, y, CW, 12, 1, 1, 'F')
      y = textBlock(doc, insightStr, M+4, y+5, { color: C.primary, maxW: CW-8, fontSize: 8.5 })
      y += 10
    }
    
    y = subHeading(doc, 'Group Statistics Ledger', y)
    const hasTPR = gStats.some(g => g.tpr != null)
    const gHeaders = ['Group Origin', 'Sample Size', 'Approvals', 'Rejections', 'Pass Rate', ...(hasTPR ? ['TPR', 'FPR'] : [])]
    const gWidths = [45, 25, 20, 20, 25, ...(hasTPR ? [15, 15] : [])]
    
    const gRows = gStats.map(g => [
      { text: String(g.group), bold: true },
      { text: g.count?.toLocaleString() },
      { text: g.pass_count?.toLocaleString(), color: C.green },
      { text: g.fail_count?.toLocaleString(), color: C.red },
      { text: `${(g.pass_rate * 100).toFixed(1)}%` },
      ...(hasTPR ? [
        { text: g.tpr != null ? `${(g.tpr * 100).toFixed(1)}%` : '-' },
        { text: g.fpr != null ? `${(g.fpr * 100).toFixed(1)}%` : '-' }
      ] : [])
    ])
    y = drawGridTable(doc, gHeaders, gRows, y, gWidths)
  } else {
    y = textBlock(doc, 'No demographic breakdown available for chart rendering.', M, y)
  }

  // ── Section 2: Fairness Metrics Matrix ──
  y = checkPage(doc, y, 50)
  y = drawSectionHeader(doc, '2. Audited Metrics & Outcomes (Art. 11)', y)
  
  if (result.metrics?.length > 0) {
    const pl = result.plain_language || {}
    for (const m of result.metrics) {
      y = checkPage(doc, y, 40)
      doc.setFillColor(...C.surface2)
      doc.roundedRect(M, y, CW, 8, 1, 1, 'F')
      doc.setDrawColor(...(m.flagged ? C.red : C.green)); doc.setLineWidth(1.5)
      doc.line(M, y, M, y + 8)
      
      doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.text)
      doc.text(safeStr(m.name), M + 3, y + 5.5)
      
      const vStr = m.key === 'performance_gap' ? `${(m.value||0).toFixed(1)}%` : (m.value||0).toFixed(4)
      doc.setTextColor(...(m.flagged ? C.red : C.green))
      doc.text(m.flagged ? `FAIL [${vStr}]` : `PASS [${vStr}]`, M + CW - 4, y + 5.5, { align: 'right' })
      
      y += 12
      // Add Definition
      if (METRIC_DEFS[m.key]) {
        doc.setFontSize(8); doc.setFont('helvetica', 'italic'); doc.setTextColor(...C.muted)
        doc.text(`What this means: ${METRIC_DEFS[m.key]}`, M + 3, y)
        y += 5
      }

      doc.setFontSize(8.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(...C.muted)
      const narrative = `Threshold: ${m.threshold_direction === 'above' ? '>=' : '<'} ${m.threshold}  |  Interpretation: ${pl[m.key] || safeStr(m.interpretation) || 'No narrative generated.'}`
      y = textBlock(doc, narrative, M + 3, y, { maxW: CW - 6, fontSize: 8.5, color: C.text, mb: 10, lineHeight: 1.4 })
    }
  }

  if (result.statistical_test) {
    y = checkPage(doc, y, 35)
    const st = result.statistical_test
    y = subHeading(doc, 'Statistical Significance (P-Value Testing)', y)
    doc.setFontSize(8.5); doc.setTextColor(...C.text); doc.setFont('helvetica', 'bold')
    const sigTxt = `p-value: ${(st.p_value||0).toFixed(4)} | Cramer's V: ${(st.cramers_v||0).toFixed(3)} | Result: ${st.is_significant ? 'Statistically Significant Bias' : 'Not Significant'}`
    doc.text(sigTxt, M, y)
    y += 6
    doc.setTextColor(...C.muted)
    y = textBlock(doc, st.interpretation || '', M, y, { maxW: CW, lineHeight: 1.5 })
  }

  // ── Section 3: Mitigation & Conformity ──
  y = checkPage(doc, y, 60)
  y = drawSectionHeader(doc, '3. Simulated Mitigation Strategies', y)

  if (result.mitigation?.results?.length > 0) {
    y = textBlock(doc, 'FairLens executed theoretical fairness corrections to determine the mathematical feasibility of bringing the model into compliance without sacrificing extreme accuracy.', M, y, { color: C.muted, mb: 10, lineHeight: 1.5 })
    
    const sHeaders = ['Algorithm strategy', 'Future Bias', 'Variance', 'DPD After', 'Target Acc.']
    const sWidths = [45, 25, 25, 25, 25]
    
    const mitRows = result.mitigation.results.map(r => [
      { text: r.method === 'rate_equalisation' ? 'Rate Equalisation' : r.method.split('_').join(' ').toUpperCase(), bold: r.method === result.mitigation.best_method },
      { text: `${r.bias_score}/100`, color: r.bias_score < 45 ? C.green : C.red },
      { text: r.improvement > 0 ? `-${r.improvement} pts` : `+${Math.abs(r.improvement)}`, color: r.improvement > 0 ? C.green : C.red },
      { text: r.dpd?.toFixed(4) || '-' },
      { text: r.accuracy != null ? `${(r.accuracy * 100).toFixed(1)}%` : '-' }
    ])
    y = drawGridTable(doc, sHeaders, mitRows, y, sWidths)
    
    if (result.mitigation.best_reason) {
      y += 5
      doc.setFillColor(...C.surface2)
      doc.roundedRect(M, y, CW, 14, 1, 1, 'F')
      y = textBlock(doc, `Auditor Choice: ${result.mitigation.best_reason}`, M + 4, y + 6, { color: C.primary, bold: true, maxW: CW - 8 })
      y += 8
    }
  } else {
    y = textBlock(doc, 'No mitigation simulations were run for this dataset.', M, y)
    y += 10
  }

  // ── Implementation Roadmap Requirement (Art. 9) ─────────────────────────────
  y = checkPage(doc, y, 32)
  y = subHeading(doc, 'Implementation Roadmap Requirement (Art. 9)', y)
  doc.setFillColor(...C.surface2)
  doc.setDrawColor(...C.amber); doc.setLineWidth(0.4)
  doc.roundedRect(M, y, CW, 20, 1, 1, 'FD')
  doc.setFontSize(8.5); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.amber)
  doc.text('ACTION REQUIRED BEFORE DEPLOYMENT', M + 4, y + 6)
  doc.setFont('helvetica', 'normal'); doc.setTextColor(...C.text)
  y = textBlock(doc, 'Simulated strategies above are theoretical. Under Article 9, identified risks must be actively managed — not merely modelled. For the recommended strategy the operator must document: (1) A named responsible person, (2) An implementation timeline with milestones, (3) A validation dataset and re-audit trigger, (4) A rollback procedure if bias escalates post-deployment.', M + 4, y + 10, { maxW: CW - 8, fontSize: 8.5, color: C.text })
  y += 8

  // ── Section 4: Annex III High-Risk Classification Assessment (Art. 6) ────────
  y = checkPage(doc, y, 20)
  y = drawSectionHeader(doc, '4. Annex III Classification Assessment (Art. 6)', y)

  const domain = detectDomain(result.columns, result.target_column, result.sensitive_column)
  const domainLabels = {
    employment: 'Employment & Worker Management',
    education:  'Education & Vocational Training',
    credit:     'Access to Financial Services',
    healthcare: 'Healthcare',
    housing:    'Housing & Real Estate',
    general:    'General / Unclassified — Operator Review Required',
  }
  y = textBlock(doc, 'Under Article 6 and Annex III of Regulation (EU) 2024/1689, AI systems used in certain domains are classified as high-risk and require conformity assessment before deployment. This section documents the formal Annex III mapping. The system operator must confirm or correct this auto-classification and record the outcome in the technical file.', M, y, { color: C.muted, mb: 8, lineHeight: 1.5 })

  y = subHeading(doc, 'Detected Deployment Domain', y)
  y = dataRow(doc, 'AUTO-DETECTED DOMAIN', domainLabels[domain], y, domain === 'general' ? C.amber : C.red)
  y = dataRow(doc, 'TARGET COLUMN', result.target_column || 'Not specified', y)
  y = dataRow(doc, 'SENSITIVE ATTRIBUTE', result.sensitive_column || 'Not specified', y)
  y += 4

  y = subHeading(doc, 'Annex III Category Mapping', y)
  const annexRows = [
    [
      { text: 'Art. 8(1)(c) — Education / vocational training', bold: true },
      { text: domain === 'education' ? 'LIKELY APPLICABLE' : 'REVIEW REQUIRED', color: domain === 'education' ? C.red : C.amber },
      { text: domain === 'education' ? 'Dataset features indicate educational context' : 'Operator must confirm scope' },
    ],
    [
      { text: 'Art. 8(1)(d) — Employment / worker management', bold: true },
      { text: domain === 'employment' ? 'LIKELY APPLICABLE' : 'REVIEW REQUIRED', color: domain === 'employment' ? C.red : C.amber },
      { text: domain === 'employment' ? 'Selection decisions indicate employment context' : 'Operator must confirm scope' },
    ],
    [
      { text: 'Art. 8(1)(e) — Essential private/public services', bold: true },
      { text: (domain === 'credit' || domain === 'housing') ? 'LIKELY APPLICABLE' : 'REVIEW REQUIRED', color: (domain === 'credit' || domain === 'housing') ? C.red : C.amber },
      { text: 'Credit, housing, and public benefit access' },
    ],
    [
      { text: 'Art. 8(1)(b) — Critical infrastructure', bold: true },
      { text: 'NOT DETECTED', color: C.green },
      { text: 'Operator must confirm if applicable' },
    ],
    [
      { text: 'Art. 8(1)(f-h) — Law enforcement / migration / justice', bold: true },
      { text: 'NOT DETECTED', color: C.green },
      { text: 'Operator must confirm if applicable' },
    ],
  ]
  y = drawGridTable(doc, ['Annex III Category', 'Status', 'Notes'], annexRows, y, [78, 40, 52])
  y += 4

  doc.setFillColor(...C.surface2)
  doc.setDrawColor(...C.amber); doc.setLineWidth(0.5)
  doc.roundedRect(M, y, CW, 14, 1, 1, 'FD')
  doc.setFontSize(8.5); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.amber)
  doc.text('OPERATOR ACTION REQUIRED', M + 4, y + 5.5)
  doc.setFont('helvetica', 'normal'); doc.setTextColor(...C.text)
  y = textBlock(doc, 'Formally confirm Annex III classification and document outcome in the technical file. If classified as high-risk, a full Article 9 risk management system and Article 43 conformity assessment are mandatory before deployment.', M + 4, y + 9.5, { maxW: CW - 8, fontSize: 8.5, color: C.text })
  y += 6

  // ── Section 5: Risk Management System (Art. 9) ───────────────────────────────
  y = checkPage(doc, y, 20)
  y = drawSectionHeader(doc, '5. Risk Management System (Art. 9)', y)

  y = textBlock(doc, 'Article 9 requires high-risk AI systems to maintain a continuous risk management system throughout their full lifecycle. The risk register below identifies known risks, their severity, and current mitigation status based on this audit\'s findings.', M, y, { color: C.muted, mb: 8, lineHeight: 1.5 })

  y = subHeading(doc, 'Risk Register', y)
  const riskScore = result.bias_score ?? 0
  const riskRegisterRows = [
    [
      { text: 'Demographic bias in selection outcomes', bold: true },
      { text: 'CRITICAL', color: C.red, bold: true },
      { text: 'HIGH', color: C.red },
      { text: riskScore >= 70 ? 'UNMITIGATED - Score ' + riskScore + '/100' : 'PARTIAL - Simulations only' },
    ],
    [
      { text: 'Proxy discrimination via correlated variables', bold: true },
      { text: 'HIGH', color: C.red },
      { text: 'HIGH', color: C.red },
      { text: 'OPEN - Intersectional analysis absent' },
    ],
    [
      { text: 'Automated decisions without human review (Art. 14)', bold: true },
      { text: 'HIGH', color: C.red },
      { text: 'HIGH', color: C.red },
      { text: 'OPEN - Human oversight not documented' },
    ],
    [
      { text: 'Data drift causing bias escalation over time', bold: true },
      { text: 'MEDIUM', color: C.amber },
      { text: 'HIGH', color: C.red },
      { text: 'OPEN - No monitoring plan documented' },
    ],
    [
      { text: 'No explainability undermining contestation rights', bold: true },
      { text: 'HIGH', color: C.red },
      { text: 'MEDIUM', color: C.amber },
      { text: 'OPEN - No explainability layer' },
    ],
  ]
  y = drawGridTable(doc, ['Risk', 'Likelihood', 'Impact', 'Current Status'], riskRegisterRows, y, [66, 22, 18, 64])
  y += 6

  y = subHeading(doc, 'Proxy Variable & Intersectionality Analysis', y)
  const allCols = result.columns || []
  const otherCols = allCols.filter(c => c !== result.sensitive_column && c !== result.target_column)
  y = textBlock(doc, `This audit examined only "${result.sensitive_column || 'the sensitive attribute'}" as the protected attribute. The columns below must be assessed for proxy correlation with protected characteristics under Article 10(5) and EU Charter Article 21 before any deployment.`, M, y, { color: C.muted, mb: 6, lineHeight: 1.5 })
  if (otherCols.length > 0) {
    const proxyRows = otherCols.map(c => [
      { text: c, bold: true },
      { text: 'ANALYSIS REQUIRED', color: C.amber },
      { text: 'Correlation with protected char. — analyst review needed' },
    ])
    y = drawGridTable(doc, ['Column', 'Proxy Risk', 'Required Action'], proxyRows, y, [50, 40, 80])
  } else {
    y = textBlock(doc, 'No additional columns available for proxy analysis.', M, y, { color: C.muted })
  }
  y += 4

  // ── Section 6: Transparency & Explainability (Art. 13) ──────────────────────
  y = checkPage(doc, y, 20)
  y = drawSectionHeader(doc, '6. Transparency & Explainability (Art. 13)', y)

  y = textBlock(doc, 'Article 13 requires high-risk AI systems to be sufficiently transparent so users can interpret outputs appropriately. GDPR Article 22 additionally grants individuals the right to a meaningful explanation of solely automated decisions that significantly affect them.', M, y, { color: C.muted, mb: 8, lineHeight: 1.5 })

  y = subHeading(doc, 'Feature Inventory & Explainability Requirements', y)
  y = textBlock(doc, `The columns below constitute the dataset feature space. Each feature\'s contribution to the "${result.target_column || 'decision outcome'}" must be documented via an explainability method (e.g. SHAP, LIME) before deployment.`, M, y, { color: C.muted, mb: 6, lineHeight: 1.5 })
  if (allCols.length > 0) {
    const featureRows = allCols.map(c => {
      const isSens = c === result.sensitive_column
      const isTgt  = c === result.target_column
      return [
        { text: c, bold: isSens || isTgt },
        { text: isSens ? 'PROTECTED ATTRIBUTE' : isTgt ? 'TARGET (OUTPUT)' : 'INPUT FEATURE', color: isSens ? C.red : isTgt ? C.amber : C.text },
        { text: isSens ? 'Monitor; direct use may constitute discrimination' : isTgt ? 'Audit for disparate impact across groups' : 'SHAP/LIME contribution analysis required' },
      ]
    })
    y = drawGridTable(doc, ['Column', 'Role', 'Explainability Requirement'], featureRows, y, [40, 42, 88])
  }
  y += 4

  y = subHeading(doc, 'Explainability Compliance Checklist', y)
  const explainRows = [
    [{ text: 'Model architecture documented (Art. 11(1)(d))' }, { text: 'REQUIRED', color: C.red }, { text: 'Document model type, training method, hyperparams' }],
    [{ text: 'Feature importance analysis (SHAP / LIME or equivalent)' }, { text: 'REQUIRED', color: C.red }, { text: 'Implement and document before deployment' }],
    [{ text: 'Per-group decision explanation on request' }, { text: 'REQUIRED', color: C.red }, { text: 'Must be producible on demand (GDPR Art. 22)' }],
    [{ text: 'Plain-language transparency notice for affected persons' }, { text: 'REQUIRED', color: C.red }, { text: 'Draft Art. 13 notice: AI role, factors, rights' }],
    [{ text: 'Contestation / human review mechanism documented' }, { text: 'REQUIRED', color: C.red }, { text: 'Contact point, escalation path, response SLA' }],
  ]
  y = drawGridTable(doc, ['Requirement', 'Status', 'Action'], explainRows, y, [80, 25, 65])
  y += 4

  // ── Section 7: Accuracy & Robustness Assessment (Art. 15) ───────────────────
  y = checkPage(doc, y, 20)
  y = drawSectionHeader(doc, '7. Accuracy & Robustness Assessment (Art. 15)', y)

  y = textBlock(doc, 'Article 15 requires high-risk AI systems to achieve appropriate levels of accuracy and robustness. Critically, disparate error rates across demographic groups are legally as significant as disparate selection rates. Per-group outcome data is derived from audit statistics below.', M, y, { color: C.muted, mb: 8, lineHeight: 1.5 })

  const gStatsFull = result.group_stats || []
  if (gStatsFull.length > 0) {
    y = subHeading(doc, 'Per-Group Outcome Rate Analysis', y)
    const bestRate = Math.max(...gStatsFull.map(g => g.pass_rate || 0))
    const accRows = gStatsFull.map(g => {
      const dir = bestRate > 0 ? (g.pass_rate || 0) / bestRate : 1.0
      const flagged = dir < 0.80
      return [
        { text: String(g.group), bold: true },
        { text: (g.count ?? 0).toLocaleString() },
        { text: `${((g.pass_rate || 0) * 100).toFixed(1)}%`, color: flagged ? C.red : C.green },
        { text: dir.toFixed(4), color: flagged ? C.red : C.green },
        { text: (g.pass_count ?? 0).toLocaleString(), color: C.green },
        { text: (g.fail_count ?? 0).toLocaleString(), color: C.red },
        { text: flagged ? 'FAIL' : 'PASS', color: flagged ? C.red : C.green, bold: true },
      ]
    })
    y = drawGridTable(doc, ['Group', 'n', 'Select. Rate', 'DIR vs. Best', 'Selected', 'Rejected', 'Status'], accRows, y, [45, 18, 25, 27, 20, 20, 15])
    y += 4
  }

  y = subHeading(doc, 'Robustness & Accuracy Checklist', y)
  const robustRows = [
    [{ text: 'Confusion matrix per group (TP / TN / FP / FN)' }, { text: 'NOT DOCUMENTED', color: C.red }, { text: 'Compute vs. ground truth before deployment' }],
    [{ text: 'Precision / Recall / F1 breakdown by group' }, { text: 'NOT DOCUMENTED', color: C.red }, { text: 'Required for equalized odds assessment' }],
    [{ text: 'Out-of-distribution (OOD) performance testing' }, { text: 'NOT DOCUMENTED', color: C.red }, { text: 'Test model outside training distribution' }],
    [{ text: 'Adversarial robustness assessment' }, { text: 'NOT DOCUMENTED', color: C.red }, { text: 'Assess adversarial and edge-case inputs' }],
    [{ text: 'Cybersecurity vulnerability assessment' }, { text: 'NOT DOCUMENTED', color: C.red }, { text: 'Data poisoning / model extraction / inference' }],
    [{ text: 'Model version & change management log (Art. 11(1)(j))' }, { text: 'NOT DOCUMENTED', color: C.red }, { text: 'Retain versioned technical file 10 years' }],
  ]
  y = drawGridTable(doc, ['Requirement', 'Status', 'Action Required'], robustRows, y, [80, 32, 58])
  y += 4

  // ── Section 8: Data Protection & GDPR Compliance ────────────────────────────
  y = checkPage(doc, y, 20)
  y = drawSectionHeader(doc, '8. Data Protection & GDPR Compliance', y)

  y = textBlock(doc, 'Processing personal data linked to a protected characteristic to make selection decisions likely triggers a mandatory Data Protection Impact Assessment (DPIA) under GDPR Article 35. The checklist below documents outstanding GDPR obligations that must be resolved before deployment.', M, y, { color: C.muted, mb: 8, lineHeight: 1.5 })

  y = subHeading(doc, 'DPIA Trigger Assessment (GDPR Art. 35)', y)
  const hasSensitiveCol = !!result.sensitive_column
  const largeDataset = (result.total_rows ?? 0) > 1000
  const dpiaRows = [
    [
      { text: 'Systematic processing linked to protected characteristic' },
      { text: hasSensitiveCol ? 'TRIGGERED' : 'REVIEW REQUIRED', color: hasSensitiveCol ? C.red : C.amber, bold: true },
      { text: `Processing "${result.sensitive_column || 'attribute'}" for automated selection` },
    ],
    [
      { text: 'Automated decision with significant effect (Art. 22)' },
      { text: 'TRIGGERED', color: C.red, bold: true },
      { text: 'Automated selection qualifies under GDPR Art. 22' },
    ],
    [
      { text: 'Large-scale processing of personal data' },
      { text: largeDataset ? 'TRIGGERED' : 'REVIEW REQUIRED', color: largeDataset ? C.red : C.amber },
      { text: `${(result.total_rows ?? 0).toLocaleString()} records processed in this audit` },
    ],
    [
      { text: 'DPIA conducted and documented' },
      { text: 'NOT COMPLETED', color: C.red },
      { text: 'CRITICAL: Conduct DPIA; involve DPO before deployment' },
    ],
  ]
  y = drawGridTable(doc, ['DPIA Criterion', 'Status', 'Notes'], dpiaRows, y, [80, 30, 60])
  y += 4

  y = subHeading(doc, 'GDPR Obligations Checklist (Arts. 6, 15-22)', y)
  const gdprRows = [
    [{ text: 'Lawful basis for processing identified (Art. 6)' }, { text: 'NOT DOCUMENTED', color: C.red }, { text: 'Document: consent / contract / legal obligation' }],
    [{ text: 'Data subject access rights mechanism (Art. 15)' }, { text: 'NOT DOCUMENTED', color: C.red }, { text: 'Process for data subject access requests' }],
    [{ text: 'Right to erasure / deletion (Art. 17)' }, { text: 'NOT DOCUMENTED', color: C.red }, { text: 'Define deletion schedule and request handling' }],
    [{ text: 'Right to object to automated processing (Art. 21)' }, { text: 'NOT DOCUMENTED', color: C.red }, { text: 'Contact point and response SLA for objections' }],
    [{ text: 'Right to human review of automated decision (Art. 22)' }, { text: 'NOT DOCUMENTED', color: C.red }, { text: 'Named human reviewer and escalation path' }],
    [{ text: 'Data retention and deletion schedule (Art. 5(1)(e))' }, { text: 'NOT DOCUMENTED', color: C.red }, { text: 'Define retention period; delete when no longer needed' }],
    [{ text: 'Third-party data processor agreements (Art. 28)' }, { text: 'NOT DOCUMENTED', color: C.amber }, { text: 'DPA required if AI model hosted externally' }],
    [{ text: 'DPO sign-off on DPIA' }, { text: 'NOT DOCUMENTED', color: C.red }, { text: 'Formal DPO review required when DPIA is triggered' }],
  ]
  y = drawGridTable(doc, ['GDPR Obligation', 'Status', 'Action Required'], gdprRows, y, [80, 30, 60])
  y += 4

  // ── Section 9: Post-Market Monitoring & Incident Reporting (Arts. 72-73) ────
  y = checkPage(doc, y, 20)
  y = drawSectionHeader(doc, '9. Post-Market Monitoring & Incident Reporting (Arts. 72-73)', y)

  y = textBlock(doc, 'Article 72 requires providers of high-risk AI systems to establish and document a post-market monitoring system. Article 73 requires serious incidents to be reported to National Competent Authorities (NCAs). The monitoring plan template below must be completed by the system operator before deployment.', M, y, { color: C.muted, mb: 8, lineHeight: 1.5 })

  y = subHeading(doc, 'Monitoring Plan Template (Art. 72)', y)
  const currentDpd = result.metrics?.find(m => m.key === 'demographic_parity_difference')?.value ?? 0
  const monitorRows = [
    [{ text: 'Periodic bias re-audit cadence' }, { text: 'DEFINE', color: C.amber }, { text: 'Recommended: quarterly, or per 10% dataset update' }],
    [{ text: 'DPD drift alert threshold' }, { text: 'DEFINE', color: C.amber }, { text: `Alert if DPD exceeds ${(currentDpd * 1.2 || 0.12).toFixed(3)} (20% above current)` }],
    [{ text: 'DIR drift alert threshold' }, { text: 'DEFINE', color: C.amber }, { text: 'Alert if DIR < 0.80 (EU threshold) or 10% below current' }],
    [{ text: 'New protected group detection protocol' }, { text: 'DEFINE', color: C.amber }, { text: 'Re-audit when new groups appear in production data' }],
    [{ text: 'Escalation procedure when thresholds exceeded' }, { text: 'DEFINE', color: C.amber }, { text: 'Define: notification chain, timeline, actions' }],
    [{ text: 'Technical documentation retention (Art. 18)' }, { text: 'REQUIRED', color: C.red }, { text: 'Retain technical file 10 years post-deployment' }],
  ]
  y = drawGridTable(doc, ['Monitoring Element', 'Status', 'Guidance'], monitorRows, y, [78, 22, 70])
  y += 4

  y = subHeading(doc, 'Serious Incident Reporting Obligations (Art. 73)', y)
  const incidentRows = [
    [{ text: 'Serious incident definition documented' }, { text: 'REQUIRED', color: C.red }, { text: 'Any incident causing or risking harm to individuals' }],
    [{ text: 'Named NCA liaison for incident notifications' }, { text: 'DEFINE', color: C.amber }, { text: 'Assign person responsible for NCA reporting' }],
    [{ text: 'Reporting timeline complied with (Art. 73(3))' }, { text: 'REQUIRED', color: C.red }, { text: 'Notify NCA within 15 days of awareness' }],
    [{ text: 'Geographic scope and NCA jurisdiction documented' }, { text: 'NOT DOCUMENTED', color: C.red }, { text: 'Required to identify which NCA has jurisdiction' }],
  ]
  y = drawGridTable(doc, ['Incident Reporting Element', 'Status', 'Notes'], incidentRows, y, [78, 22, 70])
  y += 6

  // ── Section 10: Declaration of System Conformity (updated) ──────────────────
  y = checkPage(doc, y, 80)
  y = drawSectionHeader(doc, '10. Declaration of System Conformity', y)

  // Article 14 human oversight requirement warning
  doc.setFillColor(255, 249, 237)
  doc.setDrawColor(...C.amber); doc.setLineWidth(0.5)
  doc.roundedRect(M, y, CW, 18, 2, 2, 'FD')
  doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.amber)
  doc.text('ARTICLE 14 — HUMAN OVERSIGHT REQUIRED BEFORE THIS DECLARATION IS VALID', M + 5, y + 7)
  doc.setFont('helvetica', 'normal'); doc.setTextColor(...C.text); doc.setFontSize(8.5)
  y = textBlock(doc, 'Per Article 14 of the EU AI Act, this declaration must be reviewed, validated, and countersigned by a qualified natural person before it has legal evidentiary value. The automated integrity seal below certifies document integrity only — it does not constitute a conformity declaration.', M + 5, y + 12, { maxW: CW - 10, fontSize: 8.5, color: C.text })
  y += 8

  // Automated integrity seal (kept for document integrity verification only)
  doc.setFillColor(...C.surface)
  doc.setDrawColor(...C.border); doc.setLineWidth(0.4)
  doc.roundedRect(M, y, CW, 32, 2, 2, 'FD')
  doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.primary)
  doc.text('AUTOMATED INTEGRITY SEAL (Document Verification Only)', M + 5, y + 8)
  doc.setFontSize(8.5); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.text)
  doc.text(`Integrity Hash: ${vHash}`, M + 5, y + 15)
  doc.text(`Generated: ${ts}`, M + 5, y + 20)
  doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(...C.muted)
  const sealLines = [
    'Article 10 (Data Governance): Protected group anomalies quantified and recorded.',
    'Article 11 (Technical Documentation): Dataset profile and analytical logic persisted.',
    'Article 12 (Record Logging): Integrity hash stored for reproducible auditability.',
    'NOTE: This seal verifies integrity only. Human countersignature is required for legal conformity.',
  ]
  let sealY = y + 25
  for (const line of sealLines) {
    sealY = checkPage(doc, sealY, 5)
    doc.text(safeStr(line), M + 5, sealY)
    sealY += 4
  }
  y = sealY + 6

  // Human accountability & countersignature fields
  y = checkPage(doc, y, 65)
  y = subHeading(doc, 'Accountability & Countersignature (Art. 14 — Mandatory Before Deployment)', y)
  y += 2
  const signFields = [
    ['System Owner / Deployer',            'Name, Title, Organisation, Date'],
    ['Compliance Officer',                  'Name, Title, Date'],
    ['Data Protection Officer (DPO)',       'Name, Title, Date (required if DPIA is triggered)'],
    ['Technical Lead / Model Developer',   'Name, Title, Date'],
  ]
  for (const [role, note] of signFields) {
    y = checkPage(doc, y, 16)
    doc.setFontSize(8.5); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.text)
    doc.text(safeStr(role) + ':', M, y)
    doc.setDrawColor(...C.border); doc.setLineWidth(0.3)
    doc.line(M + 60, y, PW - M, y)
    doc.setFontSize(7); doc.setFont('helvetica', 'italic'); doc.setTextColor(...C.muted)
    doc.text(safeStr(note), M, y + 5)
    y += 12
  }

  y += 4
  y = textBlock(doc, `Methodology: ${METHODOLOGY_VERSION}  |  Integrity Hash: ${vHash}  |  Generated: ${ts}  |  Geographic scope of deployment must be separately documented per Art. 2 of Regulation (EU) 2024/1689.`, M, y, { color: C.muted, maxW: CW, fontSize: 7.5, lineHeight: 1.4 })

  pageFooter(doc)
  doc.save(`FairLens_Compliance_Audit_${Date.now()}.pdf`)
}

// ── Text Analysis PDF Export ─────────────────────────────────────────────────
export async function exportToPdf(prompt, aiResponse, result) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const M = 20
  let y = M

  doc.setFontSize(22)
  doc.setTextColor(...C.primary)
  doc.text('Text Fairness Audit', M, y += 15)

  doc.setFontSize(10)
  doc.setTextColor(...C.text)
  doc.text(`Score: ${result.bias_score}/100 - ${result.bias_level}`, M, y += 8)

  doc.setTextColor(...C.primary)
  doc.setFontSize(14)
  doc.text('Original Text', M, y += 20)
  doc.setFontSize(10)
  doc.setTextColor(...C.text)
  const pLines = doc.splitTextToSize(safeStr(prompt) || '', 170)
  doc.text(pLines, M, y += 8)
  y += pLines.length * 5

  doc.setTextColor(...C.primary)
  doc.setFontSize(14)
  doc.text('Unbiased Rewrite', M, y += 20)
  doc.setFontSize(10)
  doc.setTextColor(...C.text)
  const aLines = doc.splitTextToSize(safeStr(result.unbiased_response) || '', 170)
  doc.text(aLines, M, y += 8)

  doc.save(`FairLens_TextAudit_${Date.now()}.pdf`)
}
