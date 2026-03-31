/**
 * exportPdf.js — EU AI Act Compliance Report Generator (FairLens White Theme)
 *
 * Designed to feel like the FairLens app (Orange accents, rounded soft styling)
 * but optimized for professional white-background document printing. 
 * Includes native jsPDF vector graphics, automated signatures, and plain english context.
 */

import { jsPDF } from 'jspdf'
import { createComplianceSnapshot } from './compliance'

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
const MAX_TABLE_CELL_CHARS = 1200
const MAX_TABLE_CELL_LINES = 14
const AUTO_GENERATED_PLACEHOLDER_REGEX = /^(auto[\s-_]?computed|auto[\s-_]?generated|inferred|estimated)$/i
const HUMAN_APPROVAL_FIELDS = new Set([
  'lawful_basis',
  'decision_maker',
  'oversight_contact',
  'oversight_description',
  'annex_confirmation',
])

const PW = 210, PH = 297 // A4 in mm
const M = 20             // Margin
const CW = PW - 2 * M    // Content Width
const FOOTER_H = 15

const EMPTY_COMPLIANCE = {
  dataset_name: 'NOT PROVIDED',
  dataset_version: 'NOT PROVIDED',
  data_source: 'NOT PROVIDED',
  collection_method: 'NOT PROVIDED',
  labeling_method: 'NOT PROVIDED',
  preprocessing_steps: 'NOT PROVIDED',
  known_biases: 'NOT PROVIDED',
  data_minimization_justification: 'NOT PROVIDED',
  annex_classification: 'NOT PROVIDED',
  decision_maker: 'NOT PROVIDED',
  decision_date: 'NOT PROVIDED',
  justification: 'NOT PROVIDED',
  risk_register: [],
  lawful_basis: 'NOT PROVIDED',
  purpose_of_processing: 'NOT PROVIDED',
  data_categories: 'NOT PROVIDED',
  retention_period: 'NOT PROVIDED',
  dpia_status: 'NOT PROVIDED',
  dpia_link: 'NOT PROVIDED',
  dsar_process_description: 'NOT PROVIDED',
  dpo_contact: 'NOT PROVIDED',
  oversight_contact: 'NOT PROVIDED',
  oversight_description: 'NOT PROVIDED',
  escalation_contact: 'NOT PROVIDED',
  review_sla: 'NOT PROVIDED',
  human_intervention_points: 'NOT PROVIDED',
  per_group_metrics: [],
  ood_testing: 'NOT PROVIDED',
  adversarial_testing: 'NOT PROVIDED',
  security_assessment_link: 'NOT PROVIDED',
  validator_name: 'NOT PROVIDED',
  validation_date: 'NOT PROVIDED',
  log_retention_policy: 'NOT PROVIDED',
  log_storage_location: 'NOT PROVIDED',
  monitoring_frequency: 'NOT PROVIDED',
  alert_channel: 'NOT PROVIDED',
  incident_response_description: 'NOT PROVIDED',
  intended_use: 'NOT PROVIDED',
  intended_users: 'NOT PROVIDED',
  limitations: 'NOT PROVIDED',
  known_failure_modes: 'NOT PROVIDED',
  instructions_for_use: 'NOT PROVIDED',
  nca_jurisdiction: 'NOT PROVIDED',
  monitoring_cadence: 'NOT PROVIDED',
  escalation_plan: 'NOT PROVIDED',
  annex_confirmation: 'NOT PROVIDED',
  countersignatures: [],
  robustness_validation: {
    status: 'not_documented',
    validator_role: 'Technical Lead / Model Developer',
    per_group: [],
    ood_testing: { status: 'not_documented' },
    adversarial_testing: { status: 'not_documented' },
  },
}

// ── Strict Definitions ───────────────────────────────────────────────────────
const METRIC_DEFS = {
  'demographic_parity_difference': 'Measures the absolute difference in positive outcome rates between groups. A lower score means groups are treated more equally.',
  'disparate_impact_ratio': 'The ratio of the lowest-performing group\'s pass rate against the highest. The EU typically desires a ratio of 0.8 (80%) or higher.',
  'theil_index': 'A generalized entropy index measuring total systemic inequality across all individuals simultaneously. 0 means perfect equality.',
  'performance_gap': 'The average difference in a key numeric feature (e.g. score) between the highest and lowest performing groups. A lower gap indicates more equitable feature distributions.',
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

function normalizeCompliance(meta) {
  const base = JSON.parse(JSON.stringify(EMPTY_COMPLIANCE))
  if (!meta) return base
  const merged = { ...base, ...meta }
  merged.countersignatures = Array.isArray(meta?.countersignatures) ? meta.countersignatures : []
  merged.risk_register = Array.isArray(meta?.risk_register) ? meta.risk_register : []
  merged.per_group_metrics = Array.isArray(meta?.per_group_metrics) ? meta.per_group_metrics : []
  const rv = meta?.robustness_validation || {}
  merged.robustness_validation = {
    ...base.robustness_validation,
    ...rv,
    per_group: Array.isArray(rv.per_group) ? rv.per_group : [],
    ood_testing: rv.ood_testing || { status: 'not_documented' },
    adversarial_testing: rv.adversarial_testing || { status: 'not_documented' },
  }
  const requiredStrings = Object.keys(base).filter(k => typeof base[k] === 'string')
  for (const key of requiredStrings) {
    if (!merged[key] || !String(merged[key]).trim()) merged[key] = 'NOT PROVIDED'
    if (HUMAN_APPROVAL_FIELDS.has(key) && AUTO_GENERATED_PLACEHOLDER_REGEX.test(String(merged[key]).trim())) {
      merged[key] = 'NOT PROVIDED'
    }
  }
  return merged
}

function isMissingValue(value) {
  if (value == null) return true
  const s = String(value).trim()
  return !s || s === 'NOT PROVIDED'
}

function formatStatusLabel(status, role) {
  if (status === 'validated') return 'VALIDATED'
  if (status === 'pending_validation') return `AUTO-COMPUTED — pending validation${role ? ` (${role})` : ''}`
  if (status === 'not_documented') return 'NOT DOCUMENTED'
  return safeStr(status || 'NOT DOCUMENTED')
}

function statusColor(status) {
  if (status === 'validated') return C.green
  if (status === 'pending_validation') return C.amber
  return C.red
}

async function generateVerificationHash(str) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
    return 'SHA256:' + Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
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
  const headerH = 8
  const padY = 2.5
  const lineHeight = 3.6
  const maxY = PH - FOOTER_H - 15

  const drawHeader = (startY) => {
    doc.setFillColor(...C.surface2)
    doc.rect(M, startY, CW, headerH, 'F')
    doc.setDrawColor(...C.border); doc.setLineWidth(0.3)
    doc.line(M, startY, M + CW, startY)
    doc.line(M, startY + headerH, M + CW, startY + headerH)

    doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.primary)
    let hx = M + 2
    for (let i = 0; i < headers.length; i++) {
      doc.text(safeStr(headers[i]), hx, startY + 5.5)
      hx += colWidths[i]
    }
    return startY + headerH
  }

  y = checkPage(doc, y, headerH + 5)
  y = drawHeader(y)

  const getCellLines = (rawText, colWidth) => {
    const availableWidth = Math.max(8, colWidth - 4)
    let text = safeStr(rawText ?? '-').replace(/\s+/g, ' ').trim() || '-'
    let truncated = false
    if (text.length > MAX_TABLE_CELL_CHARS) {
      text = `${text.slice(0, MAX_TABLE_CELL_CHARS)}...`
      truncated = true
    }
    let lines = doc.splitTextToSize(text, availableWidth)
    if (lines.length > MAX_TABLE_CELL_LINES) {
      lines = lines.slice(0, MAX_TABLE_CELL_LINES)
      truncated = true
    }
    if (truncated) {
      const suffix = ' [truncated]'
      const last = lines[lines.length - 1] || ''
      lines[lines.length - 1] = doc.splitTextToSize(`${last}${suffix}`, availableWidth)[0] || suffix
    }
    return lines
  }

  for (let r = 0; r < rows.length; r++) {
    let rowHeight = headerH
    const preparedCells = rows[r].map((cell, idx) => ({ cell, lines: getCellLines(cell.text, colWidths[idx]) }))
    const cellHeights = preparedCells.map(({ lines }) => Math.max(headerH, lines.length * lineHeight + padY * 2))
    rowHeight = Math.max(...cellHeights)

    if (y + rowHeight > maxY) {
      pageFooter(doc)
      doc.addPage()
      doc.setFillColor(...C.bg); doc.rect(0, 0, PW, PH, 'F')
      y = drawHeader(M + 10)
    }

    if (r % 2 === 1) { doc.setFillColor(...C.surface); doc.rect(M, y, CW, rowHeight, 'F') }
    doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(...C.text)
    let x = M + 2
    for (let i = 0; i < preparedCells.length; i++) {
      const { cell, lines } = preparedCells[i]
      doc.setTextColor(...(cell.color || C.text))
      doc.setFont('helvetica', cell.bold ? 'bold' : 'normal')
      let cy = y + padY + 3
      for (const line of lines) {
        doc.text(line, x, cy)
        cy += lineHeight
      }
      x += colWidths[i]
    }
    y += rowHeight
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
  
  let compliance = normalizeCompliance(result?.compliance_metadata)
  let integrityHash = await generateVerificationHash(JSON.stringify(result) + ts)
  let exportHash = integrityHash
  let recordId = null
  let hashValid = false

  try {
    const snapshot = await createComplianceSnapshot({
      audit_result: result,
      compliance_metadata: result?.compliance_metadata || undefined,
    })
    compliance = normalizeCompliance(snapshot?.compliance_metadata)
    integrityHash = snapshot?.integrity_hash || integrityHash
    exportHash = snapshot?.export_integrity_hash || integrityHash
    recordId = snapshot?.record_id || null
    hashValid = !!snapshot?.hash_valid
  } catch (err) {
    console.warn('Failed to persist compliance record, falling back to local hash.', err)
  }

  doc.setFillColor(...C.bg); doc.rect(0, 0, PW, PH, 'F')
  doc.setFillColor(...C.primary)
  doc.rect(0, 0, PW, 6, 'F')
  doc.setFillColor(...C.surface2)
  doc.rect(M, 6, CW, 1, 'F')
  doc.setFontSize(24); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.primary)
  doc.text('FairLens Automated Compliance Analysis', M, 34)
  doc.setFontSize(12); doc.setTextColor(...C.text)
  doc.text('EU AI Act & GDPR Audit-Defensible Report (Non-Enforcing Tool)', M, 42)

  let y = 55
  y = drawSectionHeader(doc, '1. Title & Metadata', y)
  const rowValue = (v) => isMissingValue(v) ? 'NOT PROVIDED' : v
  const exportHashLabel = exportHash || 'NOT COMPUTED (secure cryptographic API unavailable)'
  const currentHashLabel = integrityHash || 'NOT COMPUTED (secure cryptographic API unavailable)'
  y = dataRow(doc, 'REPORT DATE', dateStr, y)
  y = dataRow(doc, 'TIMESTAMP', ts, y)
  y = dataRow(doc, 'DATASET DESCRIPTION', rowValue(description), y, isMissingValue(description) ? C.red : C.text)
  y = dataRow(doc, 'DATASET NAME', compliance.dataset_name, y, isMissingValue(compliance.dataset_name) ? C.red : C.text)
  y = dataRow(doc, 'DATASET VERSION', compliance.dataset_version, y, isMissingValue(compliance.dataset_version) ? C.red : C.text)
  y = dataRow(doc, 'RECORDS PROCESSED', result.total_rows?.toLocaleString() ?? '-', y)
  y = dataRow(doc, 'COMPLIANCE RECORD', recordId || 'Not stored (offline export)', y, recordId ? C.text : C.amber)
  y = dataRow(doc, 'INTEGRITY HASH (EXPORT)', exportHashLabel, y, hashValid ? C.green : C.amber)
  y = dataRow(doc, 'INTEGRITY HASH (CURRENT)', currentHashLabel, y, integrityHash ? C.text : C.red)
  y = dataRow(doc, 'HASH STATUS', hashValid ? 'COMPUTED MATCH AGAINST SERVER RECORD' : (exportHash ? 'COMPUTED LOCAL SNAPSHOT' : 'NOT COMPUTED'), y, hashValid ? C.green : C.amber)

  y = drawSectionHeader(doc, '2. Scope & Limitations (Mandatory Disclaimer)', y + 6)
  const scopeLimit = 'This report is a standalone, non-enforcing compliance analysis tool. It documents declared controls and detected gaps using provided metadata and audit outputs. It does not certify legal conformity, does not block deployment, and does not replace legal counsel or notified-body assessment.'
  y = textBlock(doc, scopeLimit, M, y, { color: C.muted, lineHeight: 1.5 })

  const requiredGapFields = [
    ['DPIA status', compliance.dpia_status],
    ['Lawful basis', compliance.lawful_basis],
    ['Purpose of processing', compliance.purpose_of_processing],
    ['Retention period', compliance.retention_period],
    ['Security assessment link', compliance.security_assessment_link],
    ['Oversight description', compliance.oversight_description],
    ['Escalation contact', compliance.escalation_contact],
    ['Annex classification', compliance.annex_classification],
    ['Annex decision maker', compliance.decision_maker],
    ['Annex decision date', compliance.decision_date],
    ['Annex justification', compliance.justification],
  ]
  if (!isValidDescription(description)) requiredGapFields.push(['Dataset description quality', 'NOT PROVIDED'])
  const criticalGaps = requiredGapFields.filter(([, value]) => isMissingValue(value)).map(([name]) => name)

  y = drawSectionHeader(doc, '3. Critical Gaps Summary (Auto-Generated)', y + 4)
  if (criticalGaps.length > 0) {
    const gapRows = criticalGaps.map(g => [{ text: 'CRITICAL GAP', color: C.red, bold: true }, { text: g, color: C.red }, { text: 'Provide structured evidence before relying on this report.' }])
    y = drawGridTable(doc, ['Indicator', 'Missing Element', 'Required Action'], gapRows, y, [32, 60, 88])
  } else {
    y = textBlock(doc, 'No critical gaps detected in mandatory core fields.', M, y, { color: C.green })
  }

  const domain = detectDomain(result.columns, result.target_column, result.sensitive_column)
  y = drawSectionHeader(doc, '4. Use Case Context', y + 4)
  y = dataRow(doc, 'TARGET DECISION', result.target_column || 'NOT PROVIDED', y, isMissingValue(result.target_column) ? C.red : C.text)
  y = dataRow(doc, 'SENSITIVE ATTRIBUTE', result.sensitive_column || 'NOT PROVIDED', y, isMissingValue(result.sensitive_column) ? C.red : C.text)
  y = dataRow(doc, 'AUTO-DETECTED DOMAIN', domain, y, domain === 'general' ? C.amber : C.text)
  y = dataRow(doc, 'ANNEX CLASSIFICATION', compliance.annex_classification, y, isMissingValue(compliance.annex_classification) ? C.red : C.text)
  y = dataRow(doc, 'DECISION MAKER', compliance.decision_maker, y, isMissingValue(compliance.decision_maker) ? C.red : C.text)
  y = dataRow(doc, 'DECISION DATE', compliance.decision_date, y, isMissingValue(compliance.decision_date) ? C.red : C.text)
  y = textBlock(doc, `Justification: ${compliance.justification}`, M, y, { color: isMissingValue(compliance.justification) ? C.red : C.text, fontSize: 8.5 })

  y = drawSectionHeader(doc, '5. Data Governance (Art. 10)', y + 4)
  const dgRows = [
    ['dataset_name', compliance.dataset_name],
    ['dataset_version', compliance.dataset_version],
    ['data_source', compliance.data_source],
    ['collection_method', compliance.collection_method],
    ['labeling_method', compliance.labeling_method],
    ['preprocessing_steps', compliance.preprocessing_steps],
    ['known_biases', compliance.known_biases],
    ['data_minimization_justification', compliance.data_minimization_justification],
  ].map(([k, v]) => [
    { text: k, bold: true },
    { text: v, color: isMissingValue(v) ? C.red : C.text },
    { text: isMissingValue(v) ? 'NOT PROVIDED' : 'Provided' },
  ])
  y = drawGridTable(doc, ['Field', 'Value', 'Status'], dgRows, y, [55, 85, 40])

  y = drawSectionHeader(doc, '6. Risk Management (Art. 9)', y + 4)
  const risks = Array.isArray(compliance.risk_register) ? compliance.risk_register : []
  if (risks.length > 0) {
    const riskRows = risks.map(r => [
      { text: r.risk_description || 'NOT PROVIDED', color: isMissingValue(r.risk_description) ? C.red : C.text },
      { text: r.severity || 'NOT PROVIDED', color: isMissingValue(r.severity) ? C.red : C.text },
      { text: r.likelihood || 'NOT PROVIDED', color: isMissingValue(r.likelihood) ? C.red : C.text },
      { text: r.mitigation || 'NOT PROVIDED', color: isMissingValue(r.mitigation) ? C.red : C.text },
      { text: r.owner || 'NOT PROVIDED', color: isMissingValue(r.owner) ? C.red : C.text },
      { text: r.status || 'NOT PROVIDED', color: isMissingValue(r.status) ? C.red : C.text },
      { text: r.last_reviewed_date || 'NOT PROVIDED', color: isMissingValue(r.last_reviewed_date) ? C.red : C.text },
    ])
    y = drawGridTable(doc, ['Risk', 'Severity', 'Likelihood', 'Mitigation', 'Owner', 'Status', 'Last Reviewed'], riskRows, y, [44, 16, 18, 32, 20, 20, 30])
  } else {
    y = textBlock(doc, 'Risk register entries are NOT PROVIDED.', M, y, { color: C.red })
  }

  y = drawSectionHeader(doc, '7. Bias & Fairness Analysis', y + 4)
  y = drawRiskGauge(doc, result.bias_score ?? 0, euRisk, y + 4)
  const metricsRows = (result.metrics || []).map(m => [
    { text: m.name || m.key, bold: true },
    { text: m.value != null ? Number(m.value).toFixed(4) : 'NOT PROVIDED', color: m.flagged ? C.red : C.green },
    { text: m.flagged ? 'FLAGGED' : 'PASS', color: m.flagged ? C.red : C.green },
    { text: m.threshold != null ? `${m.threshold_direction === 'above' ? '>=' : '<='} ${m.threshold}` : 'NOT PROVIDED' },
  ])
  if (metricsRows.length) y = drawGridTable(doc, ['Metric', 'Value', 'Status', 'Threshold'], metricsRows, y, [70, 30, 30, 50])
  const gStats = result.group_stats || []
  if (gStats.length > 0) y = drawBarChart(doc, gStats, 'group', 'pass_rate', M + 10, y, CW - 20, 44)

  y = drawSectionHeader(doc, '8. Human Oversight (Art. 14)', y + 2)
  y = textBlock(doc, 'Declared oversight mechanism (not system-enforced).', M, y, { color: C.amber, bold: true })
  const oversightRows = [
    ['oversight_description', compliance.oversight_description],
    ['escalation_contact', compliance.escalation_contact],
    ['review_SLA', compliance.review_sla],
    ['human_intervention_points', compliance.human_intervention_points],
  ].map(([k, v]) => [{ text: k, bold: true }, { text: v, color: isMissingValue(v) ? C.red : C.text }])
  y = drawGridTable(doc, ['Field', 'Value'], oversightRows, y, [60, 120])

  y = drawSectionHeader(doc, '9. Robustness & Cybersecurity (Art. 15)', y + 4)
  const pgm = Array.isArray(compliance.per_group_metrics) ? compliance.per_group_metrics : []
  if (pgm.length > 0) {
    const pgRows = pgm.map(p => [
      { text: p.group || 'NOT PROVIDED' },
      { text: p.precision != null ? String(p.precision) : 'NOT PROVIDED', color: p.precision != null ? C.text : C.red },
      { text: p.recall != null ? String(p.recall) : 'NOT PROVIDED', color: p.recall != null ? C.text : C.red },
      { text: p.fpr != null ? String(p.fpr) : 'NOT PROVIDED', color: p.fpr != null ? C.text : C.red },
      { text: p.tpr != null ? String(p.tpr) : 'NOT PROVIDED', color: p.tpr != null ? C.text : C.red },
    ])
    y = drawGridTable(doc, ['Group', 'Precision', 'Recall', 'FPR', 'TPR'], pgRows, y, [45, 30, 30, 30, 45])
  } else {
    y = textBlock(doc, 'Per-group metrics are NOT PROVIDED.', M, y, { color: C.red })
  }
  const secRows = [
    ['OOD testing', compliance.ood_testing],
    ['Adversarial testing', compliance.adversarial_testing],
    ['security_assessment_link', compliance.security_assessment_link],
    ['validator_name', compliance.validator_name],
    ['validation_date', compliance.validation_date],
  ].map(([k, v]) => [{ text: k, bold: true }, { text: v, color: isMissingValue(v) ? C.red : C.text }])
  y = drawGridTable(doc, ['Field', 'Value'], secRows, y, [60, 120])

  y = drawSectionHeader(doc, '10. Transparency & Instructions for Use (Art. 13)', y + 4)
  const transRows = [
    ['intended_use', compliance.intended_use],
    ['intended_users', compliance.intended_users],
    ['limitations', compliance.limitations],
    ['known_failure_modes', compliance.known_failure_modes],
    ['instructions_for_use', compliance.instructions_for_use],
  ].map(([k, v]) => [{ text: k, bold: true }, { text: v, color: isMissingValue(v) ? C.red : C.text }])
  y = drawGridTable(doc, ['Field', 'Value'], transRows, y, [60, 120])

  y = drawSectionHeader(doc, '11. GDPR Compliance Snapshot', y + 4)
  const gdprRows = [
    ['lawful_basis', compliance.lawful_basis],
    ['purpose_of_processing', compliance.purpose_of_processing],
    ['data_categories', compliance.data_categories],
    ['retention_period', compliance.retention_period],
    ['dpia_status', compliance.dpia_status],
    ['dpia_link', compliance.dpia_link],
    ['dsar_process_description', compliance.dsar_process_description],
  ].map(([k, v]) => [{ text: k, bold: true }, { text: v, color: isMissingValue(v) ? C.red : C.text }])
  y = drawGridTable(doc, ['Field', 'Value'], gdprRows, y, [60, 120])

  y = drawSectionHeader(doc, '12. Logging & Monitoring (Declared)', y + 4)
  y = textBlock(doc, 'Declared logging & monitoring (standalone system, not integrated).', M, y, { color: C.amber, bold: true })
  const lmRows = [
    ['log_retention_policy', compliance.log_retention_policy],
    ['log_storage_location', compliance.log_storage_location],
    ['monitoring_frequency', compliance.monitoring_frequency],
    ['alert_channel', compliance.alert_channel],
    ['incident_response_description', compliance.incident_response_description],
  ].map(([k, v]) => [{ text: k, bold: true }, { text: v, color: isMissingValue(v) ? C.red : C.text }])
  y = drawGridTable(doc, ['Field', 'Value'], lmRows, y, [60, 120])

  const sectionCompleteness = {
    data_governance: dgRows.filter(r => r[2].text === 'Provided').length / dgRows.length,
    gdpr: gdprRows.filter(r => !isMissingValue(r[1].text)).length / gdprRows.length,
    risk_management: risks.length > 0 ? 1 : 0,
    oversight: oversightRows.filter(r => !isMissingValue(r[1].text)).length / oversightRows.length,
    robustness: (pgm.length > 0 ? 1 : 0) * 0.5 + (secRows.filter(r => !isMissingValue(r[1].text)).length / secRows.length) * 0.5,
    transparency: transRows.filter(r => !isMissingValue(r[1].text)).length / transRows.length,
    logging_monitoring: lmRows.filter(r => !isMissingValue(r[1].text)).length / lmRows.length,
  }
  const overallScore = Math.round((Object.values(sectionCompleteness).reduce((a, b) => a + b, 0) / Object.keys(sectionCompleteness).length) * 100)
  y = drawSectionHeader(doc, '13. Audit Readiness Score', y + 4)
  const scoreRows = Object.entries(sectionCompleteness).map(([k, v]) => [
    { text: k.replace(/_/g, ' ').toUpperCase(), bold: true },
    { text: `${Math.round(v * 100)}%`, color: v < 0.6 ? C.red : v < 0.85 ? C.amber : C.green },
  ])
  scoreRows.push([{ text: 'OVERALL SCORE', bold: true }, { text: `${overallScore}%`, color: overallScore < 60 ? C.red : overallScore < 85 ? C.amber : C.green }])
  y = drawGridTable(doc, ['Category', 'Completeness'], scoreRows, y, [120, 60])

  y = drawSectionHeader(doc, '14. Recommended Actions', y + 4)
  const recs = []
  if (criticalGaps.length > 0) recs.push(`Resolve critical gaps: ${criticalGaps.join(', ')}`)
  if (!risks.length) recs.push('Populate structured risk register with owner, status, and last review date.')
  if (!pgm.length) recs.push('Provide per-group precision/recall/FPR/TPR metrics and validation evidence.')
  if (recs.length === 0) recs.push('Maintain evidence freshness and re-run this analysis after each model/data change.')
  y = drawGridTable(doc, ['Priority Action'], recs.map(r => [{ text: r }]), y, [180])

  y = drawSectionHeader(doc, '15. Appendix (metrics, hash, metadata)', y + 4)
  const appendixRows = [
    [{ text: 'Methodology Version' }, { text: METHODOLOGY_VERSION }],
    [{ text: 'Methodology Hash' }, { text: METHODOLOGY_HASH }],
    [{ text: 'Compliance Record ID' }, { text: recordId || 'N/A' }],
    [{ text: 'Export Hash' }, { text: exportHashLabel }],
    [{ text: 'Current Hash' }, { text: currentHashLabel }],
    [{ text: 'Hash Status' }, { text: hashValid ? 'COMPUTED MATCH' : (exportHash ? 'COMPUTED LOCAL SNAPSHOT' : 'NOT COMPUTED') }],
    [{ text: 'Bias Score / Level' }, { text: `${result.bias_score ?? '-'} / ${result.bias_level || euRisk.level}` }],
  ]
  y = drawGridTable(doc, ['Field', 'Value'], appendixRows, y, [70, 110])

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
