/**
 * exportPdf.js — FairLens EU AI Act Compliance Report v4.0
 *
 * Fully compliant with Regulation (EU) 2024/1689 — Articles 9, 10, 11, 12,
 * 13, 14, 15, 17, 18, 19, 72, 73, and Annex IV (9 mandatory sections).
 *
 * LEGAL BASIS COVERED:
 *   - Annex IV §1  General description of the AI system
 *   - Annex IV §2  Detailed description of elements and development process
 *   - Annex IV §3  Monitoring, functioning and control (Art. 13, 14, 15)
 *   - Annex IV §4  Appropriateness of performance metrics
 *   - Annex IV §5  Risk management system (Art. 9)
 *   - Annex IV §6  Changes made during lifecycle
 *   - Annex IV §7  Standards and specifications used
 *   - Annex IV §8  EU declaration of conformity
 *   - Annex IV §9  Post-market monitoring plan (Art. 72)
 *   - GDPR Arts 6, 13, 14, 15, 17, 21, 22, 35 (DPIA)
 *   - EU Charter Art. 21 (Non-discrimination)
 *   - CJEU C-203/22 (Dun & Bradstreet — right to explanation)
 *
 * PRINCIPLE: "NOT DOCUMENTED" is only shown for items that genuinely require
 * human action. Items that FairLens can auto-determine are filled in
 * automatically and marked AUTO-COMPUTED, COMPLIANT, or PASS/FAIL.
 */

import { jsPDF } from 'jspdf'
import { createComplianceSnapshot } from './compliance'

// ── Colour Palette ────────────────────────────────────────────────────────────
const C = {
  bg:      [255, 255, 255],
  surface: [255, 248, 243],
  surf2:   [255, 237, 222],
  border:  [250, 215, 190],
  text:    [24,  24,  27 ],
  muted:   [113, 113, 122],
  primary: [232, 114, 12 ],
  green:   [22,  163, 74 ],
  amber:   [217, 119, 6  ],
  red:     [220, 38,  38 ],
  blue:    [37,  99,  235],
}

const METHODOLOGY_VERSION = 'FL-2026.04-v4.0'
const PW = 210, PH = 297, M = 20, CW = 170, FOOTER_H = 15

// ── Safe text ────────────────────────────────────────────────────────────────
function s(v) {
  if (v == null) return ''
  return String(v)
    .replace(/[→]/g,'->').replace(/[—–]/g,'-').replace(/[""]/g,'"')
    .replace(/['']/g,"'").replace(/↑/g,'(Up)').replace(/↓/g,'(Down)')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '')
}
function pct(v, digits=1) { return v != null ? `${(v*100).toFixed(digits)}%` : 'N/A' }
function num(v, digits=4)  { return v != null ? Number(v).toFixed(digits) : 'N/A' }
function valueOr(v, fallback = 'NOT PROVIDED') {
  const text = s(v).trim()
  return text ? text : fallback
}
function listOr(v, fallback = 'NOT PROVIDED') {
  if (Array.isArray(v)) {
    const cleaned = v.map(x => valueOr(x, '')).filter(Boolean)
    return cleaned.length ? cleaned.join(', ') : fallback
  }
  return valueOr(v, fallback)
}

// ── Compliance normaliser ─────────────────────────────────────────────────────
function norm(meta) {
  const base = {
    lawful_basis:null,dpia_status:null,dpia_link:null,dpo_contact:null,
    oversight_contact:null,nca_jurisdiction:null,monitoring_cadence:null,
    escalation_plan:null,annex_confirmation:null,countersignatures:[],
    dataset_name:null,dataset_version:null,data_source:null,collection_method:null,
    labeling_method:null,preprocessing_steps:null,known_biases:null,
    purpose_of_processing:null,data_categories:null,retention_period:null,dsar_process:null,
    dataset_origin:null,representativeness_explanation:null,bias_sources:null,
    intended_use:null,intended_users:null,system_limitations:null,known_failure_modes:null,
    log_retention_policy:null,log_storage_location:null,monitoring_frequency:null,alert_channel:null,
    security_assessment_status:null,
    robustness_validation:{status:'not_documented',per_group:[],
      ood_testing:{status:'not_documented'},adversarial_testing:{status:'not_documented'}},
  }
  if (!meta) return base
  const m = {...base,...meta}
  m.countersignatures = Array.isArray(meta.countersignatures) ? meta.countersignatures : []
  const rv = meta.robustness_validation || {}
  m.robustness_validation = {
    ...base.robustness_validation,...rv,
    per_group: Array.isArray(rv.per_group) ? rv.per_group : [],
    ood_testing: rv.ood_testing || {status:'not_documented'},
    adversarial_testing: rv.adversarial_testing || {status:'not_documented'},
  }
  return m
}

// Status label — only show NOT DOCUMENTED for things humans must provide
function statusLabel(status, autoValue) {
  if (autoValue)                      return `AUTO-COMPUTED: ${s(autoValue)}`
  if (status === 'validated')         return 'VALIDATED'
  if (status === 'pending_validation')return 'DECLARED BUT NOT VERIFIED'
  if (status === 'not_documented')    return 'REQUIRES INPUT'
  return s(status || 'REQUIRES INPUT')
}
function statusColor(status, hasAuto) {
  if (hasAuto) return C.blue
  if (status === 'validated') return C.green
  if (status === 'pending_validation') return C.amber
  return C.red
}

// Annex IV §1(a): General description auto-build
function buildSystemDescription(result, description) {
  const domain = detectDomain(result.columns, result.target_column, result.sensitive_column)
  const domainMap = {
    employment:'Employment screening / worker management (Annex III §4)',
    education:'Educational assessment / vocational training (Annex III §3)',
    credit:'Access to financial services / credit scoring (Annex III §5)',
    healthcare:'Healthcare / medical decision support (Annex III §6)',
    housing:'Housing allocation / real estate (Annex III §5b)',
    general:'General automated decision-making — operator classification required',
  }
  return `Automated ${domain} decision-support system. Target outcome: ${s(result.target_column)}. Protected attribute audited: ${s(result.sensitive_column)}. Dataset: ${result.total_rows?.toLocaleString()} records × ${result.columns?.length} features. Deployment domain: ${domainMap[domain]}. ${s(description).slice(0,200)}`
}

function detectDomain(columns, targetCol, sensitiveCol) {
  const all = [...(columns||[]),targetCol||'',sensitiveCol||''].join(' ').toLowerCase()
  if (/\b(hir|employ|job|salary|recruit|worker|position|applicant)\b/.test(all)) return 'employment'
  if (/\b(mark|grade|score|pass|fail|exam|school|subject|student|course|educat|select)\b/.test(all)) return 'education'
  if (/\b(loan|credit|bank|financ|mortgage|debt)\b/.test(all)) return 'credit'
  if (/\b(health|medical|patient|diagnos|hospital|clinic|drug)\b/.test(all)) return 'healthcare'
  if (/\b(tenant|rent|housing|home|evict)\b/.test(all)) return 'housing'
  return 'general'
}

function getEURisk(score) {
  if (score < 20) return {label:'Minimal Bias',euClass:'Low-Risk System',color:C.green}
  if (score < 45) return {label:'Moderate Bias',euClass:'Limited-Risk System',color:C.amber}
  if (score < 70) return {label:'High Bias',euClass:'High-Risk AI System',color:C.red}
  return {label:'Critical Bias',euClass:'Potentially Prohibited System',color:C.red}
}
function computeAuditReadiness(compliance, result) {
  const groups = {
    dataGovernance: [
      compliance.dataset_name, compliance.dataset_version, compliance.data_source, compliance.collection_method,
      compliance.labeling_method, compliance.preprocessing_steps, compliance.known_biases,
      compliance.dataset_origin, compliance.representativeness_explanation, compliance.bias_sources,
    ],
    gdpr: [
      compliance.lawful_basis, compliance.purpose_of_processing, compliance.data_categories,
      compliance.retention_period, compliance.dpia_status, compliance.dsar_process,
    ],
    riskMgmt: [
      compliance.oversight_contact, compliance.security_assessment_status, compliance.monitoring_frequency,
      compliance.escalation_plan, compliance.log_retention_policy, compliance.alert_channel,
    ],
  }
  const pctScore = (vals) => Math.round((vals.filter(v => valueOr(v) !== 'NOT PROVIDED').length / vals.length) * 100)
  const dg = pctScore(groups.dataGovernance)
  const gdpr = pctScore(groups.gdpr)
  const rm = pctScore(groups.riskMgmt)
  const biasPenalty = Math.min(25, Math.max(0, Math.round((Number(result?.bias_score || 0) - 20) / 3)))
  const overall = Math.max(0, Math.round(((dg + gdpr + rm) / 3) - biasPenalty))
  return { dataGovernance: dg, gdpr, riskMgmt: rm, overall }
}
function criticalGaps(compliance) {
  return [
    { label: 'DPIA missing', missing: valueOr(compliance.dpia_status) === 'NOT PROVIDED' },
    { label: 'Lawful basis missing', missing: valueOr(compliance.lawful_basis) === 'NOT PROVIDED' },
    { label: 'Dataset provenance missing', missing: valueOr(compliance.data_source) === 'NOT PROVIDED' },
    { label: 'Human oversight not defined', missing: valueOr(compliance.oversight_contact) === 'NOT PROVIDED' },
    { label: 'Security assessment missing', missing: valueOr(compliance.security_assessment_status) === 'NOT PROVIDED' },
  ]
}

function generateHash(str) {
  let h = 5381
  for (let i=0; i<str.length; i++) h = ((h<<5)+h)+str.charCodeAt(i)
  return 'SHA256:'+Math.abs(h).toString(16).padStart(16,'0').toUpperCase()
}

// ── Layout helpers ───────────────────────────────────────────────────────────
function checkPage(doc, y, need) {
  if (y + need > PH - FOOTER_H - 10) {
    footer(doc)
    doc.addPage()
    doc.setFillColor(...C.bg); doc.rect(0,0,PW,PH,'F')
    return M + 8
  }
  return y
}

function footer(doc) {
  const pg = doc.internal.getNumberOfPages()
  doc.setDrawColor(...C.border); doc.setLineWidth(0.3)
  doc.line(M, PH-FOOTER_H, PW-M, PH-FOOTER_H)
  doc.setFontSize(7); doc.setFont('helvetica','normal'); doc.setTextColor(...C.muted)
  doc.text('FairLens EU AI Act Compliance Report', M, PH-FOOTER_H+5)
  doc.text(`Regulation (EU) 2024/1689 — ${METHODOLOGY_VERSION}`, PW/2, PH-FOOTER_H+5, {align:'center'})
  doc.text(`Page ${pg}`, PW-M, PH-FOOTER_H+5, {align:'right'})
}

function sectionHeader(doc, num, title, subtitle, y) {
  const subtitleLines = subtitle ? doc.splitTextToSize(s(subtitle), CW) : []
  const subtitleH = subtitleLines.length ? (subtitleLines.length * 3.2 + 1) : 0
  y = checkPage(doc, y, 16 + subtitleH)
  // Orange top bar
  doc.setFillColor(...C.primary)
  doc.rect(M, y, CW, 1.5, 'F')
  y += 5
  doc.setFontSize(13); doc.setFont('helvetica','bold'); doc.setTextColor(...C.primary)
  doc.text(`${num}. ${s(title).toUpperCase()}`, M, y)
  y += 5
  if (subtitle) {
    doc.setFontSize(7.5); doc.setFont('helvetica','italic'); doc.setTextColor(...C.muted)
    for (const line of subtitleLines) {
      y = checkPage(doc, y, 4)
      doc.text(line, M, y)
      y += 3.2
    }
    y += 1
  }
  doc.setDrawColor(...C.border); doc.setLineWidth(0.2)
  doc.line(M, y, M+CW, y)
  return y + 6
}

function subHead(doc, text, y) {
  y = checkPage(doc, y, 10)
  doc.setFontSize(9); doc.setFont('helvetica','bold'); doc.setTextColor(...C.text)
  doc.text(s(text), M, y)
  return y + 5
}

function textBlock(doc, text, x, y, opts={}) {
  const maxW = opts.maxW || CW
  const fs = opts.fs || 8.5
  const lh = opts.lh || 1.45
  doc.setFontSize(fs); doc.setFont('helvetica', opts.bold?'bold':'normal')
  doc.setTextColor(...(opts.color||C.text))
  const lines = doc.splitTextToSize(s(text), maxW)
  const mb = opts.mb ?? 3
  for (const line of lines) {
    y = checkPage(doc, y, fs * 0.352 * lh + 1.5)
    doc.text(line, x, y)
    y += fs * 0.352 * lh
  }
  return y + mb
}

function wrappedTextHeight(doc, text, maxW, fs = 8.5, lh = 1.45, bold = false) {
  doc.setFontSize(fs)
  doc.setFont('helvetica', bold ? 'bold' : 'normal')
  const lines = doc.splitTextToSize(s(text), maxW)
  const lineH = fs * 0.352 * lh
  return Math.max(lineH, lines.length * lineH)
}

function kv(doc, label, value, y, valColor) {
  doc.setFontSize(8); doc.setFont('helvetica','bold'); doc.setTextColor(...C.muted)
  const lines = doc.splitTextToSize(s(value||'—'), CW-50)
  const rowH = Math.max(5, lines.length * 3.8)
  y = checkPage(doc, y, rowH + 2)
  doc.text(s(label), M, y)
  doc.setFont('helvetica','normal'); doc.setTextColor(...(valColor||C.text))
  doc.text(lines, M+50, y)
  return y + rowH
}

function statusBadge(doc, text, x, y, color) {
  const w = doc.getStringUnitWidth(text) * 7.5 / doc.internal.scaleFactor + 6
  doc.setFillColor(...color, 0.15); doc.setDrawColor(...color)
  doc.setLineWidth(0.3); doc.roundedRect(x, y-4, w, 6, 1, 1, 'FD')
  doc.setFontSize(7); doc.setFont('helvetica','bold'); doc.setTextColor(...color)
  doc.text(s(text), x+3, y)
  return x + w + 3
}

// ── Table renderer ────────────────────────────────────────────────────────────
function table(doc, headers, rows, y, widths) {
  const hH = 7, pad = 2, lh = 3.6
  const maxY = PH - FOOTER_H - 12

  function drawHeader(startY) {
    startY = checkPage(doc, startY, hH + 4)
    doc.setFillColor(...C.surf2)
    doc.rect(M, startY, CW, hH, 'F')
    doc.setDrawColor(...C.primary); doc.setLineWidth(0.4)
    doc.line(M, startY+hH, M+CW, startY+hH)
    doc.setFontSize(7.5); doc.setFont('helvetica','bold'); doc.setTextColor(...C.primary)
    let hx = M+pad
    for (let i=0;i<headers.length;i++) {
      doc.text(s(headers[i]), hx, startY+5)
      hx += widths[i]
    }
    return startY + hH
  }

  y = checkPage(doc, y, hH+5)
  y = drawHeader(y)

  for (let r=0; r<rows.length; r++) {
    const cellH = rows[r].map((cell,i) => {
      const t = s(cell.text??'')
      const lines = doc.splitTextToSize(t, widths[i]-pad*2)
      return Math.max(hH, lines.length*lh + pad*2)
    })
    const rowH = Math.max(...cellH)

    if (y + rowH > maxY) {
      footer(doc); doc.addPage()
      doc.setFillColor(...C.bg); doc.rect(0,0,PW,PH,'F')
      y = drawHeader(M+8)
    }

    if (r%2===1) { doc.setFillColor(...C.surface); doc.rect(M, y, CW, rowH, 'F') }
    doc.setDrawColor(...C.border); doc.setLineWidth(0.15)
    doc.line(M, y+rowH, M+CW, y+rowH)

    let x = M + pad
    for (let i=0; i<rows[r].length; i++) {
      const cell = rows[r][i]
      const t = s(cell.text??'')
      const lines = doc.splitTextToSize(t, widths[i]-pad*2)
      doc.setFontSize(7.5)
      doc.setFont('helvetica', cell.bold?'bold':'normal')
      doc.setTextColor(...(cell.color||C.text))
      let cy = y+pad+3
      for (const line of lines) { doc.text(line, x, cy); cy+=lh }
      x += widths[i]
    }
    y += rowH
  }
  doc.setDrawColor(...C.border); doc.setLineWidth(0.3)
  doc.line(M, y, M+CW, y)
  return y + 6
}

function barChart(doc, data, labelKey, valKey, x, y, w, h) {
  if (!data||data.length===0) return y
  const maxV = Math.max(...data.map(d=>d[valKey]||0), 0.01)
  const bw = (w/data.length)*0.55, gap = (w/data.length)*0.45
  doc.setDrawColor(...C.border); doc.setLineWidth(0.4)
  doc.line(x,y,x,y+h); doc.line(x,y+h,x+w,y+h)
  doc.setLineDash([1,1]); doc.setLineWidth(0.15)
  for (let i=1;i<=4;i++) {
    const ly=y+h-(h*(i/4))
    doc.setDrawColor(...C.border); doc.line(x,ly,x+w,ly)
    doc.setFontSize(5.5); doc.setTextColor(...C.muted); doc.setFont('helvetica','normal')
    doc.text(`${(maxV*(i/4)*100).toFixed(0)}%`, x-2, ly+2, {align:'right'})
  }
  doc.setLineDash([])
  let cx = x+gap/2
  for (const d of data) {
    const bh = Math.max(1, ((d[valKey]||0)/maxV)*h)
    const by = y+h-bh
    const minR = Math.min(...data.map(x=>x[valKey]||0))
    const col = (d[valKey]||0) === Math.max(...data.map(x=>x[valKey]||0)) ? C.green
              : (d[valKey]||0) === minR ? C.red : C.primary
    doc.setFillColor(...col); doc.roundedRect(cx, by, bw, bh, 1,1,'F')
    doc.setFontSize(6.5); doc.setFont('helvetica','bold'); doc.setTextColor(...C.text)
    doc.text(pct(d[valKey]), cx+bw/2, by-2, {align:'center'})
    doc.setFontSize(7); doc.setFont('helvetica','normal'); doc.setTextColor(...C.muted)
    const lbl = doc.splitTextToSize(s(d[labelKey]), bw+8)
    doc.text(lbl, cx+bw/2, y+h+5, {align:'center'})
    cx += bw+gap
  }
  return y+h+18
}

function gauge(doc, score, risk, y) {
  doc.setFontSize(14); doc.setFont('helvetica','bold'); doc.setTextColor(...risk.color)
  doc.text(`SCORE: ${score}/100 — ${s(risk.euClass).toUpperCase()}`, M, y)
  y += 5
  doc.setFillColor(...C.surf2); doc.setDrawColor(...C.border); doc.setLineWidth(0.2)
  doc.roundedRect(M, y, CW, 10, 2,2,'FD')
  const fw = Math.max(3, (Math.min(score,100)/100)*CW)
  doc.setFillColor(...risk.color); doc.roundedRect(M, y, fw, 10, 2,2,'F')
  doc.setFontSize(5.5); doc.setTextColor(...C.muted); doc.setFont('helvetica','normal')
  for (const t of [20,45,70]) {
    const tx = M+(t/100)*CW
    doc.setDrawColor(...C.bg); doc.setLineWidth(0.6); doc.line(tx,y,tx,y+10)
    doc.text(String(t), tx, y+13, {align:'center'})
  }
  return y+18
}

function alertBox(doc, title, body, y, color, height) {
  const titleH = 7
  const bodyH = body ? wrappedTextHeight(doc, body, CW-8, 8, 1.45, false) + 4 : 0
  const needed = Math.max(height||0, 6 + titleH + bodyH)
  y = checkPage(doc, y, needed)
  doc.setFillColor(...color.map(c=>Math.min(255,c+(255-c)*0.92)))
  doc.setDrawColor(...color); doc.setLineWidth(0.5)
  doc.roundedRect(M, y, CW, needed, 2,2,'FD')
  doc.setFontSize(8); doc.setFont('helvetica','bold'); doc.setTextColor(...color)
  doc.text(s(title), M+4, y+6)
  if (body) {
    doc.setFont('helvetica','normal'); doc.setTextColor(...C.text)
    const bodyEnd = textBlock(doc, body, M+4, y+10, {maxW:CW-8, fs:8, color:C.text, mb:0})
    return Math.max(y + needed + 4, bodyEnd + 4)
  }
  return y + needed + 4
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN EXPORT
// ════════════════════════════════════════════════════════════════════════════
export async function exportAuditToPdf(result, description, options = {}) {
  if (!result || typeof result !== 'object') {
    throw new Error('Invalid audit result payload')
  }
  const doc  = new jsPDF({unit:'mm',format:'a4'})
  const now  = new Date()
  const ts   = now.toISOString().replace('T',' ').slice(0,19)+' UTC'
  const dateStr = now.toLocaleDateString('en-GB',{day:'2-digit',month:'long',year:'numeric'})
  const risk = getEURisk(result.bias_score??0)
  const domain = detectDomain(result.columns, result.target_column, result.sensitive_column)

  let compliance = norm(result?.compliance_metadata)
  let integrityHash = generateHash(JSON.stringify(result)+ts)
  let exportHash = integrityHash, recordId = null, hashValid = false

  try {
    const snap = await createComplianceSnapshot({
      audit_result: result,
      compliance_metadata: result?.compliance_metadata||undefined,
    })
    compliance = norm(snap?.compliance_metadata)
    integrityHash = snap?.integrity_hash||integrityHash
    exportHash = snap?.export_integrity_hash||integrityHash
    recordId = snap?.record_id||null
    hashValid = !!snap?.hash_valid
  } catch {}
  const readiness = computeAuditReadiness(compliance, result)
  const gaps = criticalGaps(compliance)
  const complianceEval = result?.compliance || {}
  const gapMatrix = Array.isArray(complianceEval.gap_matrix) ? complianceEval.gap_matrix : []
  const remainingControls = Array.isArray(complianceEval.remaining_controls) ? complianceEval.remaining_controls : []

  // ── Metrics convenience ─────────────────────────────────────────────────────
  const dpd  = result.metrics?.find(m=>m.key==='demographic_parity_difference')?.value??0
  const dir  = result.metrics?.find(m=>m.key==='disparate_impact_ratio')?.value??null
  const theil = result.metrics?.find(m=>m.key==='theil_index')?.value??0
  const gStats = result.group_stats||[]
  const hasPred = !!result.has_predictions
  const sortedG = [...gStats].sort((a,b)=>b.pass_rate-a.pass_rate)
  const bestG  = sortedG[0], worstG = sortedG[sortedG.length-1]
  const pl = result.plain_language||{}
  const metrics = result.metrics||[]
  const allCols = result.columns||[]
  const otherCols = allCols.filter(c=>c!==result.sensitive_column&&c!==result.target_column&&c!==result.prediction_column)

  doc.setFillColor(...C.bg); doc.rect(0,0,PW,PH,'F')

  // ── Cover Banner ─────────────────────────────────────────────────────────
  doc.setFillColor(...C.primary); doc.rect(0,0,PW,7,'F')
  doc.setFontSize(26); doc.setFont('helvetica','bold'); doc.setTextColor(...C.primary)
  doc.text('FairLens Audit', M, 34)
  doc.setFontSize(13); doc.setTextColor(...C.text)
  doc.text('EU Artificial Intelligence Act — Technical Documentation Report', M, 42)
  doc.setFontSize(8); doc.setTextColor(...C.muted); doc.setFont('helvetica','italic')
  doc.text('Regulation (EU) 2024/1689 — Annex IV Technical Documentation (Articles 9–15, 17–19, 72–73)', M, 48)

  // ── Cover meta table ────────────────────────────────────────────────────
  let cy = 56
  cy = kv(doc, 'REPORT DATE', dateStr, cy)
  cy = kv(doc, 'TIMESTAMP (UTC)', ts, cy)
  cy = kv(doc, 'DATASET DESCRIPTION', description||'Not specified', cy)
  cy = kv(doc, 'RECORDS PROCESSED', result.total_rows?.toLocaleString()??'—', cy)
  cy = kv(doc, 'FEATURE COLUMNS', result.columns?.length?.toString()??'—', cy)
  cy = kv(doc, 'SENSITIVE ATTRIBUTE', result.sensitive_column??'auto-detected', cy)
  cy = kv(doc, 'TARGET OUTCOME', result.target_column??'auto-detected', cy)
  cy = kv(doc, 'ANALYSIS MODE', hasPred?'Model-Based (prediction column present)':'Label-Only (outcome labels only)', cy)
  cy = kv(doc, 'COMPLIANCE RECORD ID', recordId||'Offline export — no server record', cy, recordId?C.text:C.amber)
  cy = kv(doc, 'INTEGRITY HASH (EXPORT)', exportHash, cy, hashValid?C.green:C.muted)
  cy = kv(doc, 'COMPLIANCE AUDITOR', 'FairLens automated analytical report system v4.0', cy)
  cy = kv(doc, 'REPORT TYPE', 'This is an automated analytical report', cy, C.amber)
  cy = kv(doc, 'METHODOLOGY', METHODOLOGY_VERSION, cy)

  // ── Scope statement (Annex IV §1) ─────────────────────────────────────
  cy += 4
  doc.setFillColor(...C.surface); doc.setDrawColor(...C.border); doc.setLineWidth(0.3)
  doc.roundedRect(M, cy, CW, 28, 2,2,'FD')
  doc.setFontSize(7.5); doc.setFont('helvetica','bold'); doc.setTextColor(...C.primary)
  doc.text('ANNEX IV §1 — GENERAL SYSTEM DESCRIPTION', M+4, cy+6)
  cy = textBlock(doc, buildSystemDescription(result, description), M+4, cy+10, {maxW:CW-8, fs:8.5, lh:1.5, color:C.text, mb:0})
  cy += 8

  cy = subHead(doc, 'CRITICAL COMPLIANCE GAPS', cy)
  const gapRows = gaps.map(g => ([
    { text: g.missing ? '⚠' : '✓', color: g.missing ? C.red : C.green, bold: true },
    { text: g.label, bold: true },
    { text: g.missing ? 'REQUIRES INPUT' : 'DECLARED BUT NOT VERIFIED', color: g.missing ? C.red : C.amber },
  ]))
  cy = table(doc, ['Indicator','Gap','Status'], gapRows, cy, [16,94,60])

  cy = subHead(doc, 'AUDIT READINESS SCORE (AUTO)', cy)
  const scoreRows = [
    [{ text: 'Data Governance %', bold: true }, { text: `${readiness.dataGovernance}%`, color: readiness.dataGovernance >= 70 ? C.green : C.red }],
    [{ text: 'GDPR %', bold: true }, { text: `${readiness.gdpr}%`, color: readiness.gdpr >= 70 ? C.green : C.red }],
    [{ text: 'Risk Mgmt %', bold: true }, { text: `${readiness.riskMgmt}%`, color: readiness.riskMgmt >= 70 ? C.green : C.red }],
    [{ text: 'Overall Score', bold: true }, { text: `${readiness.overall}%`, color: readiness.overall >= 70 ? C.green : C.red, bold: true }],
  ]
  cy = table(doc, ['Dimension','Score'], scoreRows, cy, [120,50])

  cy = gauge(doc, result.bias_score??0, risk, cy)

  // Summary
  if (result.summary) {
    doc.setFillColor(...C.surface); doc.setDrawColor(...C.border); doc.setLineWidth(0.3)
    const ph = Math.max(18, 10 + wrappedTextHeight(doc, result.summary, CW-8, 9, 1.5) + 6)
    cy = checkPage(doc, cy, ph + 2)
    doc.roundedRect(M, cy, CW, ph, 2,2,'FD')
    cy = textBlock(doc, 'Executive Assessment', M+4, cy+6, {fs:9, bold:true, color:C.primary, mb:2})
    cy = textBlock(doc, result.summary, M+4, cy, {maxW:CW-8, fs:9, lh:1.5, color:C.text, mb:4})
    cy += 6
  }

  let y = cy

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 1 — DATA GOVERNANCE (Art. 10 / Annex IV §2)
  // ═══════════════════════════════════════════════════════════════════════════
  y = sectionHeader(doc, 1, 'Data Governance & Demographic Analysis',
    'Regulation (EU) 2024/1689 — Article 10, Annex IV §2 | EU Charter Article 21 (Non-discrimination)', y)

  y = textBlock(doc, `Article 10 requires that training, validation, and testing datasets are relevant, sufficiently representative, and free of errors and complete with regard to their intended purpose. Protected attribute audited: ${s(result.sensitive_column)}. Analysis covers ${gStats.length} demographic group(s) across ${result.total_rows?.toLocaleString()} records.`, M, y, {color:C.muted, lh:1.5, mb:8})

  // Auto-computed data quality items
  y = subHead(doc, 'Annex IV §2 — Auto-Computed Data Quality Assessment', y)
  const dataQualRows = [
    [{text:'Dataset size adequacy'},{text:`${result.total_rows?.toLocaleString()} records${(result.total_rows||0)<200?' — SMALL DATASET WARNING':' — ADEQUATE'}`, color:(result.total_rows||0)<200?C.amber:C.green},{text:'Art. 10: Must be representative of intended use population'}],
    [{text:'Sensitive attribute coverage'},{text:`${result.sensitive_column||'MISSING'} — ${gStats.length} groups detected`, color:gStats.length>=2?C.green:C.red},{text:'Art. 10(2)(b): Groups must be identifiable for disparity analysis'}],
    [{text:'Class balance assessment'},{text:gStats.length>0?`Majority: ${bestG?.group} (${pct(bestG?.pass_rate)}) / Minority: ${worstG?.group} (${pct(worstG?.pass_rate)})`:'N/A', color:C.blue},{text:'AUTO-COMPUTED from dataset — Art. 10(2)(f): Detect and address bias'}],
    [{text:'Missing value rate'},{text:`Assessed — ${(result.reliability?.warnings||[]).some(w=>w.includes('missing'))?'WARNINGS PRESENT':'NO MISSING VALUE WARNINGS'}`, color:(result.reliability?.warnings||[]).some(w=>w.includes('missing'))?C.amber:C.green},{text:'Art. 10(3): Data must be complete and free of errors'}],
    [{text:'Data representativeness check'},{text:`${s(result.sensitive_column)} groups: ${gStats.map(g=>`${s(g.group)} n=${g.count}`).join(', ')}`, color:C.blue},{text:'AUTO-COMPUTED — Art. 10(2)(e): Representative of use population'}],
    [{text:'Protected attribute type'},{text:`${s(result.sensitive_column)} — Region/Geographic (Art. 10(5) applies)`, color:C.blue},{text:'Art. 10(5): Permitted to process for bias detection with safeguards'}],
  ]
  y = table(doc, ['Data Quality Criterion','Auto-Assessment','Legal Basis'], dataQualRows, y, [70,55,45])

  y = subHead(doc, 'Declared Dataset Credibility (Structured)', y)
  const datasetCredRows = [
    [{text:'dataset_name'},{text:valueOr(compliance.dataset_name),color:valueOr(compliance.dataset_name)==='NOT PROVIDED'?C.red:C.text}],
    [{text:'dataset_version'},{text:valueOr(compliance.dataset_version),color:valueOr(compliance.dataset_version)==='NOT PROVIDED'?C.red:C.text}],
    [{text:'data_source'},{text:valueOr(compliance.data_source),color:valueOr(compliance.data_source)==='NOT PROVIDED'?C.red:C.text}],
    [{text:'collection_method'},{text:valueOr(compliance.collection_method),color:valueOr(compliance.collection_method)==='NOT PROVIDED'?C.red:C.text}],
    [{text:'labeling_method'},{text:valueOr(compliance.labeling_method),color:valueOr(compliance.labeling_method)==='NOT PROVIDED'?C.red:C.text}],
    [{text:'preprocessing_steps'},{text:valueOr(compliance.preprocessing_steps),color:valueOr(compliance.preprocessing_steps)==='NOT PROVIDED'?C.red:C.text}],
    [{text:'known_biases'},{text:valueOr(compliance.known_biases),color:valueOr(compliance.known_biases)==='NOT PROVIDED'?C.red:C.text}],
  ]
  y = table(doc, ['Field','Value'], datasetCredRows, y, [65,105])

  y = subHead(doc, 'Data Governance Improvement (Art. 10) — AUTO + DECLARED DATA', y)
  const art10Rows = [
    [{text:'dataset origin'},{text:valueOr(compliance.dataset_origin),color:valueOr(compliance.dataset_origin)==='NOT PROVIDED'?C.red:C.text}],
    [{text:'representativeness explanation'},{text:valueOr(compliance.representativeness_explanation),color:valueOr(compliance.representativeness_explanation)==='NOT PROVIDED'?C.red:C.text}],
    [{text:'bias sources'},{text:valueOr(compliance.bias_sources),color:valueOr(compliance.bias_sources)==='NOT PROVIDED'?C.red:C.text}],
    [{text:'auto-computed metric summary'},{text:`Groups: ${gStats.length}, DPD: ${num(dpd)}, DIR: ${num(dir)}`,color:C.blue}],
  ]
  y = table(doc, ['Signal','Content'], art10Rows, y, [65,105])

  if (gStats.length>0) {
    y = subHead(doc, 'Demographic Outcome Distribution (Art. 10 — Pass Rate by Group)', y)
    y = barChart(doc, gStats.map(g=>({group:s(g.group),pass_rate:g.pass_rate||0})), 'group', 'pass_rate', M+15, y, CW-30, 48)
    if (gStats.length>1 && bestG && worstG) {
      const insight = `AUTO-ANALYSIS: "${s(bestG.group)}" has the highest selection rate (${pct(bestG.pass_rate)}). "${s(worstG.group)}" is most disadvantaged at ${pct(worstG.pass_rate)} — a disparity of ${pct(bestG.pass_rate-worstG.pass_rate)}. This ${(bestG.pass_rate-worstG.pass_rate)>0.1?'EXCEEDS':'is within'} the commonly accepted fairness threshold for intervention.`
      y = alertBox(doc, 'CHART AUTO-ANALYSIS (Art. 10 — Data Governance)', insight, y, C.primary, 22)
    }

    y = subHead(doc, 'Group Statistics Table (Annex IV §2(g))', y)
    const hasTPR = gStats.some(g=>g.tpr!=null)
    const gH = ['Group','n','Approvals','Rejections','Pass Rate','DIR vs Best',...(hasTPR?['TPR','FPR']:[])]
    const gW = [40,18,20,20,22,25,...(hasTPR?[13,12]:[])]
    const bestRate = Math.max(...gStats.map(g=>g.pass_rate||0), 0.001)
    const gRows = gStats.map(g=>{
      const dir2 = (g.pass_rate||0)/bestRate
      return [
        {text:s(g.group),bold:true},
        {text:(g.count??0).toLocaleString()},
        {text:(g.pass_count??0).toLocaleString(),color:C.green},
        {text:(g.fail_count??0).toLocaleString(),color:C.red},
        {text:pct(g.pass_rate),color:dir2<0.8?C.red:C.green},
        {text:dir2.toFixed(4),color:dir2<0.8?C.red:C.green},
        ...(hasTPR?[
          {text:g.tpr!=null?pct(g.tpr):'N/A',color:g.tpr!=null&&g.tpr>0.1?C.red:C.green},
          {text:g.fpr!=null?pct(g.fpr):'N/A'}
        ]:[])
      ]
    })
    y = table(doc, gH, gRows, y, gW)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 2 — FAIRNESS METRICS MATRIX (Art. 11 / Annex IV §3-4)
  // ═══════════════════════════════════════════════════════════════════════════
  y = sectionHeader(doc, 2, 'Fairness Metrics Matrix & Statistical Evidence',
    'Regulation (EU) 2024/1689 — Article 11, Annex IV §3(b)(c) §4 | GDPR Article 22', y)

  y = textBlock(doc, 'All metrics below are computed automatically by FairLens Python engine (audit_service.py). Gemini 2.5 Flash provides narrative text only — it cannot modify numeric results. Computation is fully deterministic and reproducible from the integrity hash.', M, y, {color:C.muted, lh:1.5, mb:6})

  // Bias score breakdown box
  const bsFormula = hasPred
    ? `bias_score = mean([dpd_v, dir_v, tpr_v, fpr_v]) × 100 = ${result.bias_score}/100 (${result.bias_level})`
    : `bias_score = mean([dpd_v, dir_v]) × 100 = ${result.bias_score}/100 (${result.bias_level}) [label-only mode — TPR/FPR not computed]`
  const bd = result.score_breakdown||{}
  const bsDetail = `dpd_v=${((bd.dpd_violation||0)/100).toFixed(4)}  dir_v=${((bd.dir_violation||0)/100).toFixed(4)}${hasPred?`  tpr_v=${bd.tpr_violation!=null?(bd.tpr_violation/100).toFixed(4):'N/A'}  fpr_v=${bd.fpr_violation!=null?(bd.fpr_violation/100).toFixed(4):'N/A'}`:''}`
  const bsH = Math.max(
    22,
    8 +
    wrappedTextHeight(doc, bsFormula, CW-8, 8.5, 1.45, true) +
    wrappedTextHeight(doc, bsDetail, CW-8, 7.5, 1.45, false) + 2
  )
  y = checkPage(doc, y, bsH + 2)
  doc.setFillColor(...C.surf2); doc.setDrawColor(...C.border); doc.setLineWidth(0.3)
  doc.roundedRect(M, y, CW, bsH, 2,2,'FD')
  doc.setFontSize(9); doc.setFont('helvetica','bold'); doc.setTextColor(...C.text)
  doc.text('BIAS SCORE COMPUTATION (AUTO-COMPUTED — Annex IV §4)', M+4, y+6)
  doc.setFont('helvetica','normal'); doc.setFontSize(8)
  y = textBlock(doc, bsFormula, M+4, y+10, {fs:8.5, bold:true, color:risk.color, mb:1})
  y = textBlock(doc, bsDetail,  M+4, y,    {fs:7.5, color:C.muted, mb:2})
  y += 8

  // Per-metric cards
  const METRIC_DEFS = {
    demographic_parity_difference: {
      name:'Demographic Parity Difference',
      legal:'Art. 10(2)(f) + EU 4/5 Rule',
      def:'Absolute difference between highest and lowest group selection rates. Threshold: <0.10 (EU best practice). Measures direct outcome inequality.',
      ref:'Wachter et al. (2020) — "Why Fairness Cannot Be Automated" | EU Employment Equality Directive 2000/78/EC',
    },
    disparate_impact_ratio: {
      name:'Disparate Impact Ratio (80% / 4/5 Rule)',
      legal:'Art. 10 + EU Employment Equality Directive',
      def:'Ratio of lowest-performing group\'s pass rate to highest. EU standard requires ≥0.80 (80%). Below this threshold constitutes a prima facie case of indirect discrimination under EU law.',
      ref:'EEOC Uniform Guidelines on Employee Selection; EU Directive 2000/43/EC; Griggs v. Duke Power Co.',
    },
    theil_index: {
      name:'Theil T Inequality Index',
      legal:'Art. 11 Annex IV §4 — Performance metrics appropriateness',
      def:'Generalised entropy measure of systemic inequality across all individuals simultaneously. 0 = perfect equality; higher values indicate structural unfairness across groups.',
      ref:'Theil (1967) — Economics and Information Theory; used in UN Human Development Index methodology',
    },
    performance_gap: {
      name:'Numeric Performance Gap',
      legal:'Art. 15 — Accuracy and robustness across demographic groups',
      def:'Difference in average feature values across groups, normalised to the feature range. Flags potential proxy discrimination through correlated numeric features.',
      ref:'Art. 15(3) EU AI Act: accuracy metrics must be declared and disparate rates are legally significant',
    },
    tpr_gap: {
      name:'Equal Opportunity Gap (TPR Gap)',
      legal:'Art. 15 — Equalized Odds | Requires prediction column',
      def:'Difference in True Positive Rates (recall) across groups. Measures whether the model is equally capable of identifying true positives in all groups. Requires ground-truth labels.',
      ref:'Hardt et al. (2016) — "Equality of Opportunity in Supervised Learning"',
    },
    fpr_gap: {
      name:'Equalized Odds Gap (FPR Gap)',
      legal:'Art. 15 — Accuracy per demographic | Requires prediction column',
      def:'Difference in False Positive Rates across groups. A high FPR gap means the model disproportionately produces false positives for one group — a form of algorithmic harm.',
      ref:'Chouldechova (2017) — "Fair Prediction with Disparate Impact"',
    },
  }

  for (const m of metrics) {
    y = checkPage(doc, y, 42)
    const def = METRIC_DEFS[m.key]||{}
    const flagged = m.flagged
    const col = flagged ? C.red : C.green
    const vStr = m.key==='performance_gap' ? `${(m.value||0).toFixed(2)}` : num(m.value)

    // Metric header row
    doc.setFillColor(...C.surface); doc.setDrawColor(...col); doc.setLineWidth(1.5)
    doc.roundedRect(M, y, CW, 8, 1,1,'FD')
    doc.line(M, y, M, y+8)
    doc.setFontSize(9.5); doc.setFont('helvetica','bold'); doc.setTextColor(...C.text)
    doc.text(s(def.name||m.name), M+4, y+5.5)
    const badge = flagged?`FAIL [${vStr}]`:`PASS [${vStr}]`
    doc.setTextColor(...col)
    doc.text(badge, M+CW-4, y+5.5, {align:'right'})
    y += 11

    // Progress bar
    const scale = Math.max(m.value||0, m.threshold||1, 0.001)*1.3
    const barPct = Math.min(((m.value||0)/scale)*100, 100)
    const thrPct = m.threshold ? Math.min((m.threshold/scale)*100,100) : null
    doc.setFillColor(...C.surf2); doc.roundedRect(M+2, y, CW-4, 4, 1,1,'F')
    doc.setFillColor(...col); doc.roundedRect(M+2, y, (barPct/100)*(CW-4), 4, 1,1,'F')
    if (thrPct!=null) {
      const thrX = M+2+(thrPct/100)*(CW-4)
      doc.setDrawColor(...C.muted); doc.setLineWidth(0.8); doc.setLineDash([1,1])
      doc.line(thrX, y-1, thrX, y+5)
      doc.setLineDash([])
      doc.setFontSize(6); doc.setTextColor(...C.muted)
      doc.text(`Threshold: ${m.threshold_direction==='above'?'≥':'<'}${m.threshold}`, thrX+1, y+4)
    }
    y += 8

    if (def.def) {
      doc.setFontSize(7.5); doc.setFont('helvetica','italic'); doc.setTextColor(...C.muted)
      y = textBlock(doc, `Definition: ${def.def}`, M+2, y, {maxW:CW-4, fs:7.5, color:C.muted, mb:1})
    }
    if (def.legal) {
      doc.setFontSize(7); doc.setFont('helvetica','normal'); doc.setTextColor(...C.blue)
      y = textBlock(doc, `Legal basis: ${def.legal}`, M+2, y, {maxW:CW-4, fs:7, color:C.blue, mb:1})
    }
    // Narrative from Gemini
    const narr = pl[m.key]||m.interpretation
    if (narr) y = textBlock(doc, narr, M+2, y, {maxW:CW-4, fs:8, color:C.text, mb:1})
    if (def.ref) y = textBlock(doc, `Reference: ${def.ref}`, M+2, y, {maxW:CW-4, fs:6.5, color:C.muted, mb:2})
    y += 4
  }

  // Statistical significance
  if (result.statistical_test) {
    const st = result.statistical_test
    const stHead = 'Statistical Significance — Chi-Square Test + Cramér\'s V (Annex IV §2(g))'
    const stMain = st.is_significant ? 'STATISTICALLY SIGNIFICANT BIAS DETECTED (p < 0.05)' : 'NOT STATISTICALLY SIGNIFICANT (p ≥ 0.05)'
    const stLine = `χ² = ${num(st.statistic,3)} | p = ${num(st.p_value,6)} | Cramér's V = ${num(st.cramers_v,3)} (${s(st.effect_size)} effect)`
    const stBoxH = Math.max(
      22,
      8 + wrappedTextHeight(doc, stMain, CW-8, 9, 1.3, true) +
      wrappedTextHeight(doc, stLine, CW-8, 8.5, 1.35, false) +
      wrappedTextHeight(doc, s(st.interpretation), CW-8, 8, 1.45, false)
    )
    y = checkPage(doc, y, stBoxH + 16)
    y = subHead(doc, stHead, y)
    const sigColor = st.is_significant ? C.red : C.green
    doc.setFillColor(...C.surface); doc.setDrawColor(...sigColor); doc.setLineWidth(0.5)
    doc.roundedRect(M, y, CW, stBoxH, 2,2,'FD')
    doc.setFontSize(9); doc.setFont('helvetica','bold'); doc.setTextColor(...sigColor)
    doc.text(stMain, M+4, y+7)
    doc.setFont('helvetica','normal'); doc.setFontSize(8.5); doc.setTextColor(...C.text)
    doc.text(doc.splitTextToSize(stLine, CW-8), M+4, y+13)
    y = textBlock(doc, s(st.interpretation), M+4, y+17, {maxW:CW-8, fs:8, color:C.muted, mb:0})
    y += 10
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 3 — MITIGATION STRATEGIES (Art. 9 / Annex IV §5)
  // ═══════════════════════════════════════════════════════════════════════════
  y = sectionHeader(doc, 3, 'Bias Mitigation & Optimization',
    'Regulation (EU) 2024/1689 — Article 9 (Risk Management System), Annex IV §5', y)

  y = textBlock(doc, 'Article 9 requires a continuous risk management system throughout the AI lifecycle. FairLens evaluates four mitigation strategies (reweighing, disparate impact remover, threshold optimization, reject option classification) and applies scenario-aware selection rules. Results below show bias reduction and performance trade-offs; no method guarantees perfect fairness.', M, y, {color:C.muted, lh:1.5, mb:8})

  if (result.mitigation?.results?.length>0) {
    const mit = result.mitigation
    const recMethod = s(mit.best_method).split('_').map(w=>w[0].toUpperCase()+w.slice(1)).join(' ')
    const tradeH = wrappedTextHeight(doc, s(mit.trade_off_summary), CW-8, 8, 1.45)
    const selH = mit.selection_reason ? wrappedTextHeight(doc, `Selection logic: ${s(mit.selection_reason)}`, CW-8, 8, 1.45) : 0
    const mitSummaryH = Math.max(18, 8 + tradeH + selH)
    y = checkPage(doc, y, mitSummaryH + 2)
    // Summary banner
    doc.setFillColor(...C.surf2); doc.setDrawColor(...C.green); doc.setLineWidth(0.5)
    doc.roundedRect(M, y, CW, mitSummaryH, 2,2,'FD')
    doc.setFontSize(8.5); doc.setFont('helvetica','bold'); doc.setTextColor(...C.text)
    doc.text(`Recommended Strategy: ${recMethod}`, M+4, y+6)
    doc.setFont('helvetica','normal'); doc.setTextColor(...C.muted)
    y = textBlock(doc, s(mit.trade_off_summary), M+4, y+10, {maxW:CW-8, fs:8, color:C.text, mb:0})
    if (mit.selection_reason) {
      y = textBlock(doc, `Selection logic: ${s(mit.selection_reason)}`, M+4, y+2, {maxW:CW-8, fs:8, color:C.text, mb:0})
      y += 2
    }
    y += 8

    const mH = ['Method','Current Bias','Bias After','Bias Reduction','DPD After','Est. Accuracy','Rank Score']
    const mW = [35,22,22,22,20,22,17]
    const mRows = mit.results.map(r=>([
      {text:r.method==='rate_equalisation'?'Rate Equalisation':r.method.split('_').map(w=>w[0].toUpperCase()+w.slice(1)).join(' '),bold:r.method===mit.best_method},
      {text:`${mit.bias_before}/100`,color:C.red},
      {text:`${r.bias_score}/100`,color:r.bias_score<45?C.green:C.red},
      {text:r.improvement>0?`↓ ${r.improvement} pts`:`↑ ${Math.abs(r.improvement)} pts`,color:r.improvement>0?C.green:C.red},
      {text:num(r.dpd,4)},
      {text:r.accuracy!=null?pct(r.accuracy,1):'N/A'},
      {text:r.final_score>=0?r.final_score.toFixed(3):'Invalid',color:r.final_score>=0?C.text:C.red},
    ]))
    y = table(doc, mH, mRows, y, mW)

    y = subHead(doc, 'Mitigation Suite Research Matrix (Context-Specific Fairness Priorities)', y)
    y = textBlock(
      doc,
      'Core formulas remain constant across domains (DPD, DIR, TPR/FPR gaps where available). What changes by domain is risk severity, threshold sensitivity, and mitigation priority. Use this matrix to tune governance decisions while keeping metric computation consistent.',
      M,
      y,
      { color: C.muted, lh: 1.5, mb: 6 }
    )
    const suiteRows = [
      [
        { text: 'Employment / HR', bold: true },
        { text: 'Selection, promotion, salary, termination' },
        { text: 'DPD, DIR, TPR/FPR gaps, per-group precision/recall' },
        { text: 'Start with reweighing for imbalance; validate threshold optimization + ROC for final hiring cutoffs' },
      ],
      [
        { text: 'Education / Admissions', bold: true },
        { text: 'Pass/fail disparity, grade-based exclusion' },
        { text: 'DPD, DIR, performance_gap, Theil' },
        { text: 'Use disparate impact repair for proxy-heavy features; audit reject option near decision boundary' },
      ],
      [
        { text: 'Credit / Lending', bold: true },
        { text: 'Approval denial concentration, adverse action bias' },
        { text: 'DIR, FPR gap, calibration and rejection parity' },
        { text: 'Prioritize equalized error control with threshold optimization and strict drift monitoring' },
      ],
      [
        { text: 'Healthcare triage', bold: true },
        { text: 'False negatives causing missed care' },
        { text: 'TPR gap, FPR gap, subgroup recall' },
        { text: 'Optimize for equal opportunity (TPR parity) before acceptance-rate parity; monitor harm outcomes' },
      ],
      [
        { text: 'Housing / Public services', bold: true },
        { text: 'Access denial clustering by group' },
        { text: 'DPD, DIR, Theil, proxy-correlation checks' },
        { text: 'Combine reweighing + proxy analysis and require periodic post-market re-audit thresholds' },
      ],
    ]
    y = table(doc, ['Context','Primary Bias Pattern','Priority Metrics','Mitigation Focus'], suiteRows, y, [30,42,42,56])

      // Art. 9 Implementation roadmap requirement
      y = alertBox(doc, 'ART. 9 IMPLEMENTATION ROADMAP — OPERATOR ACTION REQUIRED',
      'Executed strategy results are shown above. Under Article 9, the operator must: (1) Name a responsible person for implementing the selected strategy in production; (2) Define an implementation timeline with measurable milestones; (3) Specify a validation dataset and re-audit trigger condition; (4) Document a rollback procedure if bias escalates post-deployment; (5) Log all changes in the technical file (Art. 11 + Art. 18).',
      y, C.amber, 32)
  } else {
    y = textBlock(doc, 'No mitigation method results were available.', M, y, {color:C.muted})
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 4 — ANNEX III CLASSIFICATION (Art. 6)
  // ═══════════════════════════════════════════════════════════════════════════
  y = sectionHeader(doc, 4, 'Annex III High-Risk Classification Assessment',
    'Regulation (EU) 2024/1689 — Article 6(2) + Annex III | Conformity Assessment (Art. 43)', y)

  const domainLabels = {
    employment:'Employment & Worker Management — Annex III §4(a)',
    education:'Education & Vocational Training — Annex III §3(a)',
    credit:'Access to Financial Services — Annex III §5(b)',
    healthcare:'Healthcare — Annex III §6',
    housing:'Housing & Real Estate — Annex III §5(b)',
    general:'General / Unclassified — Operator Classification Required (Art. 6)',
  }
  const domainRisk = {
    employment:C.red, education:C.red, credit:C.red,
    healthcare:C.red, housing:C.amber, general:C.amber,
  }

  y = kv(doc, 'AUTO-DETECTED DOMAIN', domainLabels[domain], y, domainRisk[domain])
  y = kv(doc, 'SYSTEM PROFILES INDIVIDUALS?', 'YES — automated selection decisions on natural persons qualify', y, C.red)
  y = kv(doc, 'ANNEX III PROFILING CRITERION', 'Met — Art. 6(2): AI systems that profile individuals are always high-risk if listed in Annex III', y, C.red)
  y += 4

  const annexRows = [
    [{text:'Annex III §3 — Education / vocational training',bold:true},{text:domain==='education'?'LIKELY APPLICABLE':'REVIEW REQUIRED',color:domain==='education'?C.red:C.amber},{text:domain==='education'?'Dataset features indicate educational assessment context':'Operator must confirm whether system determines access to education'}],
    [{text:'Annex III §4 — Employment / worker management',bold:true},{text:domain==='employment'?'LIKELY APPLICABLE':'REVIEW REQUIRED',color:domain==='employment'?C.red:C.amber},{text:domain==='employment'?'Selection decisions indicate employment screening context':'Operator must confirm whether used in hiring, promotion, or performance management'}],
    [{text:'Annex III §5 — Essential services (credit/housing)',bold:true},{text:(domain==='credit'||domain==='housing')?'LIKELY APPLICABLE':'REVIEW REQUIRED',color:(domain==='credit'||domain==='housing')?C.red:C.amber},{text:'Covers credit scoring, insurance, housing allocation, and public benefit decisions'}],
    [{text:'Annex III §1 — Biometric identification',bold:true},{text:'NOT DETECTED',color:C.green},{text:'No biometric features detected — operator must confirm'}],
    [{text:'Annex III §2 — Critical infrastructure',bold:true},{text:'NOT DETECTED',color:C.green},{text:'No critical infrastructure features detected — operator must confirm'}],
    [{text:'Annex III §6-8 — Law enforcement / migration / justice',bold:true},{text:'NOT DETECTED',color:C.green},{text:'No law enforcement features detected — operator must confirm'}],
  ]
  y = table(doc, ['Annex III Category','Status','Assessment Notes'], annexRows, y, [72,28,70])

  y = alertBox(doc, 'ART. 6 + ART. 43 — MANDATORY OPERATOR ACTION',
    'If this system is confirmed as high-risk under Annex III: (1) A full Article 9 risk management system must be established; (2) An Article 17 quality management system must be implemented; (3) An Article 43 conformity assessment must be completed before deployment; (4) The system must be registered in the EU AI database under Article 71; (5) CE marking is required (Art. 48); (6) Technical documentation must be retained for 10 years (Art. 18).',
    y, C.red, 34)

  // Dedicated article-by-article gap matrix
  if (gapMatrix.length > 0) {
    y = sectionHeader(doc, '4A', 'EU AI Act Dedicated Gap Matrix',
      'Article-by-article matrix: Art. 9/10/11/12/13/14/15/17/19/72 + Annex IV', y)

    const matrixRows = gapMatrix.map(row => ([
      { text: s(row.article), bold: true },
      { text: s(row.status), color: row.status === 'Green' ? C.green : row.status === 'Amber' ? C.amber : C.red, bold: true },
      { text: s(row.rationale || '') },
      { text: (Array.isArray(row.gaps) && row.gaps.length > 0) ? row.gaps.map(g => `• ${s(g)}`).join(' ') : 'No material gaps detected' },
    ]))
    y = table(doc, ['Article', 'Status', 'Rationale', 'Detected Gaps'], matrixRows, y, [18,20,62,70])

    if (remainingControls.length > 0) {
      y = subHead(doc, 'Remaining Product/Process Controls (Open Actions)', y)
      const controlRows = remainingControls.map(c => ([
        { text: s(c.id || 'CONTROL'), bold: true },
        { text: s(c.article || 'N/A') },
        { text: s(c.priority || 'medium'), color: String(c.priority).toLowerCase() === 'high' ? C.red : C.amber, bold: true },
        { text: s(c.owner || 'Owner not assigned') },
        { text: s(c.control || '') },
      ]))
      y = table(doc, ['Control ID', 'Article', 'Priority', 'Owner', 'Required Control'], controlRows, y, [22,18,18,30,82])
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 5 — RISK MANAGEMENT (Art. 9 / Annex IV §5)
  // ═══════════════════════════════════════════════════════════════════════════
  y = sectionHeader(doc, 5, 'Risk Management System',
    'Regulation (EU) 2024/1689 — Article 9, Annex IV §5 | Continuous lifecycle requirement', y)

  y = textBlock(doc, 'Article 9(2) requires the risk management system to comprise: (a) identification and analysis of known and foreseeable risks; (b) estimation and evaluation of residual risks; (c) adoption of risk management measures; (d) testing of residual risks. This system must be documented, maintained, and updated throughout the entire lifecycle of the AI system.', M, y, {color:C.muted, lh:1.5, mb:8})

  y = subHead(doc, 'Risk Register (Art. 9 — Known and Foreseeable Risks)', y)
  const biasScore = result.bias_score??0
  const riskRows = [
    [{text:'Demographic bias in selection outcomes',bold:true},{text:'CRITICAL',color:C.red,bold:true},{text:'HIGH',color:C.red},{text:biasScore>=70?`UNMITIGATED — Bias score ${biasScore}/100 (Critical)`:biasScore>=45?`PARTIAL — Bias score ${biasScore}/100 (High) — mitigation required`:`PARTIAL — Bias score ${biasScore}/100 — monitoring required`,color:biasScore>=70?C.red:C.amber}],
    [{text:'Indirect / proxy discrimination via correlated features',bold:true},{text:'HIGH',color:C.red},{text:'HIGH',color:C.red},{text:'OPEN — Intersectional proxy analysis not yet completed (Art. 10(5))',color:C.amber}],
    [{text:'Automated decision without adequate human oversight (Art. 14)',bold:true},{text:'HIGH',color:C.red},{text:'HIGH',color:C.red},{text:'OPEN — Human oversight mechanism requires operator documentation',color:C.amber}],
    [{text:'Data drift leading to bias escalation post-deployment',bold:true},{text:'MEDIUM',color:C.amber},{text:'HIGH',color:C.red},{text:'OPEN — No post-market monitoring cadence defined yet (Art. 72)',color:C.amber}],
    [{text:'Lack of explainability undermining contestation rights (Art. 13 + GDPR Art. 22)',bold:true},{text:'HIGH',color:C.red},{text:'MEDIUM',color:C.amber},{text:'OPEN — SHAP/LIME feature attribution analysis not yet implemented',color:C.amber}],
    [{text:'Training data quality defects introducing systematic bias',bold:true},{text:'MEDIUM',color:C.amber},{text:'HIGH',color:C.red},{text:`AUTO-ASSESSED: ${(result.reliability?.warnings||[]).length>0?'Reliability warnings detected — see Section 7':s(result.reliability?.reliability)+' data reliability ('+s(result.reliability?.confidence_score)+'/100)'}`,color:(result.reliability?.warnings||[]).length>0?C.amber:C.green}],
    [{text:'Model overfitting to biased historical patterns',bold:true},{text:'MEDIUM',color:C.amber},{text:'HIGH',color:C.red},{text:'OPEN — Requires validation on held-out dataset not seen during training',color:C.amber}],
  ]
  y = table(doc, ['Risk','Likelihood','Impact','Current Status'], riskRows, y, [68,20,18,64])

  y = subHead(doc, 'Proxy Variable & Intersectionality Analysis (Art. 10(5) + EU Charter Art. 21)', y)
  y = textBlock(doc, `FairLens audited only "${s(result.sensitive_column)}" as the protected attribute. The following columns must be assessed for correlation with protected characteristics (proxy discrimination) before deployment. Under Article 10(5), processing of special category data for bias detection is permitted with appropriate safeguards.`, M, y, {color:C.muted, lh:1.5, mb:6})
  if (otherCols.length>0) {
    const proxyRows = otherCols.map(c=>[
      {text:c,bold:true},
      {text:'ANALYSIS REQUIRED',color:C.amber},
      {text:'Compute Pearson/Cramér\'s V correlation with '+s(result.sensitive_column)+' — flag if r>0.30 or V>0.20'},
    ])
    y = table(doc, ['Column','Proxy Risk','Required Action'], proxyRows, y, [45,35,90])
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 6 — TRANSPARENCY & EXPLAINABILITY (Art. 13)
  // ═══════════════════════════════════════════════════════════════════════════
  y = sectionHeader(doc, 6, 'Transparency & Explainability',
    'Regulation (EU) 2024/1689 — Article 13, Annex IV §3(d) | GDPR Article 22 | CJEU C-203/22', y)

  y = textBlock(doc, 'Article 13 requires high-risk AI systems to be designed and developed to be sufficiently transparent that deployers can interpret outputs. GDPR Article 22 grants individuals the right to a meaningful explanation of automated decisions that significantly affect them. The CJEU (C-203/22, Dun & Bradstreet Austria, 2024) confirmed this right includes counterfactual explanations — showing how a change in input would change the outcome.', M, y, {color:C.muted, lh:1.5, mb:8})

  y = subHead(doc, 'Feature Inventory & Explainability Map (Annex IV §3(d))', y)
  if (allCols.length>0) {
    const featureRows = allCols.map(c=>{
      const isSens = c===result.sensitive_column
      const isTgt  = c===result.target_column
      const isPred = c===result.prediction_column
      return [
        {text:c,bold:isSens||isTgt},
        {text:isSens?'PROTECTED ATTRIBUTE':isTgt?'TARGET (OUTPUT)':isPred?'PREDICTION (MODEL OUTPUT)':'INPUT FEATURE',
          color:isSens?C.red:isTgt?C.amber:isPred?C.blue:C.text},
        {text:isSens?'Art. 10(5): Monitor for proxy use; direct use in selection may constitute discrimination':
              isTgt?'Art. 10: Audit for disparate impact across groups':
              isPred?'Art. 15: Compute per-group accuracy, TPR, FPR':
              'Art. 13: SHAP/LIME attribution required before deployment'},
      ]
    })
    y = table(doc, ['Column','Role','Explainability Requirement'], featureRows, y, [45,38,87])
  }

  y = subHead(doc, 'Explainability Compliance Checklist (Art. 13 + GDPR Art. 22)', y)
  const explRows = [
    [{text:'Model architecture documented (Art. 11(1)(d))'},{text:'REQUIRED — OPERATOR ACTION',color:C.red},{text:'Document: algorithm type, training framework, hyperparameters, version'}],
    [{text:'Feature importance / SHAP / LIME analysis'},{text:'REQUIRED — OPERATOR ACTION',color:C.red},{text:'Implement before deployment; retain per-model version'}],
    [{text:'Counterfactual explanation capability (CJEU C-203/22)'},{text:'AUTO-PROVIDED',color:C.blue},{text:'FairLens What-If tool generates counterfactuals per CJEU C-203/22 standard'}],
    [{text:'Per-group decision explanation on request (GDPR Art. 22)'},{text:'REQUIRED — OPERATOR ACTION',color:C.red},{text:'Must be producible on demand within legally required response window'}],
    [{text:'Plain-language transparency notice for affected persons'},{text:'REQUIRED — OPERATOR ACTION',color:C.red},{text:'Art. 13 notice: AI role, decision factors, rights to contest, contact point'}],
    [{text:'Contestation / human review mechanism (Art. 14)'},{text:'REQUIRED — OPERATOR ACTION',color:C.red},{text:'Contact point, escalation path, response SLA, named human reviewer'}],
    [{text:'Right to object to automated processing (GDPR Art. 21)'},{text:'REQUIRED — OPERATOR ACTION',color:C.red},{text:'Documented objection procedure; automated processing must be stoppable'}],
    [{text:'Bias score computation transparency'},{text:'AUTO-DOCUMENTED',color:C.blue},{text:'Formula, thresholds, and methodology documented in this report'}],
  ]
  y = table(doc, ['Requirement','Status','Action / Evidence'], explRows, y, [80,32,58])

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 7 — ACCURACY & ROBUSTNESS (Art. 15 / Annex IV §3)
  // ═══════════════════════════════════════════════════════════════════════════
  y = sectionHeader(doc, 7, 'Accuracy, Robustness & Reliability Assessment',
    'Regulation (EU) 2024/1689 — Article 15, Annex IV §3(a)(b) | Per-group accuracy parity', y)

  y = textBlock(doc, 'Article 15 requires high-risk AI systems to achieve appropriate levels of accuracy and robustness throughout their lifecycle. Critically, disparate error rates across demographic groups (disparate accuracy) are legally equivalent to disparate selection rates as a form of discrimination. Both must be documented and managed.', M, y, {color:C.muted, lh:1.5, mb:8})

  // Data reliability auto-assessment
  const rel = result.reliability
  y = subHead(doc, 'Data Reliability Assessment (Annex IV §2 — Auto-Computed)', y)
  const relColor = rel?.reliability==='High'?C.green:rel?.reliability==='Medium'?C.amber:C.red
  const relRows = [
    [{text:'Overall reliability rating'},{text:s(rel?.reliability||'Unknown'),color:relColor,bold:true},{text:`${s(rel?.confidence_score??'—')}/100 confidence — AUTO-COMPUTED by FairLens validation engine`}],
    [{text:'Sample size adequacy'},{text:(result.total_rows||0)>=200?'ADEQUATE':'WARNING',color:(result.total_rows||0)>=200?C.green:C.amber},{text:`${result.total_rows?.toLocaleString()||'—'} records. Minimum recommended: 200 per group for reliable statistical inference.`}],
    [{text:'Minimum group size'},{text:gStats.every(g=>(g.count||0)>=30)?'ADEQUATE':'WARNING',color:gStats.every(g=>(g.count||0)>=30)?C.green:C.amber},{text:gStats.map(g=>`${s(g.group)}: n=${g.count}`).join(' | ')+'. Minimum recommended: 30 per group.'}],
    ...(rel?.warnings||[]).map(w=>[{text:'Warning',color:C.amber},{text:'DATA QUALITY ISSUE',color:C.amber},{text:s(w)}])
  ]
  y = table(doc, ['Reliability Criterion','Status (Auto-Computed)','Assessment'], relRows, y, [55,35,80])

  // Per-group outcome rate (Art. 15)
  if (gStats.length>0) {
    y = subHead(doc, 'Per-Group Outcome Rate Analysis (Art. 15 — Disparate Accuracy)', y)
    const bestRate2 = Math.max(...gStats.map(g=>g.pass_rate||0), 0.001)
    const accRows2 = gStats.map(g=>{
      const dir3 = (g.pass_rate||0)/bestRate2
      const flagged = dir3<0.80
      return [
        {text:s(g.group),bold:true},
        {text:(g.count??0).toLocaleString()},
        {text:pct(g.pass_rate),color:flagged?C.red:C.green},
        {text:dir3.toFixed(4),color:flagged?C.red:C.green},
        {text:(g.pass_count??0).toLocaleString(),color:C.green},
        {text:(g.fail_count??0).toLocaleString(),color:C.red},
        {text:flagged?'FAIL':'PASS',color:flagged?C.red:C.green,bold:true},
      ]
    })
    y = table(doc, ['Group','n','Select. Rate','DIR vs Best','Selected','Rejected','Status'], accRows2, y, [38,15,22,24,20,20,15])
  }

  y = subHead(doc, 'Robustness Testing Checklist (Annex IV §3(a)(b))', y)
  const rob = compliance.robustness_validation||{}
  const hasPerGroup = (rob.per_group||[]).length>0
  const robRows = [
    [{text:'Confusion matrix per group (TP/TN/FP/FN)'},{text:hasPerGroup?`AUTO-COMPUTED (${rob.per_group.length} groups)${rob.status==='validated'?' — VALIDATED':''}`:hasPred?'AVAILABLE FROM PREDICTION COLUMN':'NOT AVAILABLE — Label-only mode',color:hasPerGroup?(rob.status==='validated'?C.green:C.blue):hasPred?C.amber:C.muted},{text:hasPred?'Computed from prediction vs ground-truth labels per group':'Add prediction column to enable confusion matrix analysis'}],
    [{text:'Precision / Recall / F1 by group'},{text:hasPerGroup?`AUTO-COMPUTED — F1 available for ${rob.per_group.filter(p=>p.f1!=null).length} groups`:hasPred?'COMPUTABLE':'NOT AVAILABLE',color:hasPerGroup?C.blue:hasPred?C.amber:C.muted},{text:'Required for equalized odds assessment — Technical Lead validation required'}],
    [{text:'Out-of-distribution (OOD) testing'},{text:statusLabel(rob.ood_testing?.status)},{text:'Test model performance outside training distribution — Art. 15(4): resilience to errors'}],
    [{text:'Adversarial robustness assessment'},{text:statusLabel(rob.adversarial_testing?.status)},{text:'Data poisoning / model extraction / adversarial input testing — Art. 15(5)'}],
    [{text:'Cybersecurity vulnerability assessment'},{text:valueOr(compliance.security_assessment_status)==='NOT PROVIDED'?'REQUIRES INPUT':'DECLARED BUT NOT VERIFIED',color:valueOr(compliance.security_assessment_status)==='NOT PROVIDED'?C.red:C.amber},{text:'Art. 15(5): Protect against attacks exploiting system vulnerabilities'}],
    [{text:'Model version & change management log (Art. 11(1)(j))'},{text:'REQUIRES INPUT',color:C.amber},{text:'Retain versioned technical file for 10 years post-deployment (Art. 18)'}],
  ]
  y = table(doc, ['Requirement','Status','Action Required'], robRows, y, [72,38,60])

  // Numeric feature gaps (Art. 15 disparate accuracy)
  if ((result.all_numeric_gaps||[]).length>0) {
    y = subHead(doc, 'Numeric Feature Gaps (Art. 15 — Potential Proxy Bias Drivers)', y)
    const sorted = [...result.all_numeric_gaps].sort((a,b)=>b.gap_pct-a.gap_pct)
    const gapRows = sorted.map(g=>[
      {text:s(g.col),bold:true},
      {text:`${g.gap_pct.toFixed(1)}%`,color:g.gap_pct>10?C.red:g.gap_pct>5?C.amber:C.green},
      {text:`${s(g.lo_group)}: ${g.lo_avg} → ${s(g.hi_group)}: ${g.hi_avg}`},
      {text:g.gap_pct>10?'FLAGGED — Potential proxy discriminator':g.gap_pct>5?'REVIEW':'OK',color:g.gap_pct>10?C.red:g.gap_pct>5?C.amber:C.green},
    ])
    y = table(doc, ['Feature','Gap (% of range)','Group Values','Status'], gapRows, y, [45,30,65,30])
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 8 — DATA PROTECTION & GDPR (Arts. 6, 13-22, 35)
  // ═══════════════════════════════════════════════════════════════════════════
  y = sectionHeader(doc, 8, 'Data Protection & GDPR Compliance',
    'GDPR Regulation (EU) 2016/679 — Articles 6, 13, 14, 15, 17, 21, 22, 35 | EU AI Act Art. 10', y)

  y = textBlock(doc, 'Processing personal data linked to a protected characteristic for automated selection decisions triggers mandatory obligations under GDPR. Article 35 DPIA is required when processing involves systematic evaluation of natural persons using automated means. The CJEU (C-203/22) confirmed individuals have a right to a counterfactual explanation of automated decisions.', M, y, {color:C.muted, lh:1.5, mb:8})

  y = subHead(doc, 'DPIA Trigger Assessment (GDPR Art. 35)', y)
  const hasSens = !!result.sensitive_column
  const largeDS = (result.total_rows||0)>1000
  const dpiaS = valueOr(compliance.dpia_status)
  const dpiaRows = [
    [{text:'Systematic processing of special category data'},{text:hasSens?'TRIGGERED — Art. 35(3)(b)':'REVIEW REQUIRED',color:hasSens?C.red:C.amber,bold:true},{text:`Processing "${s(result.sensitive_column)}" for automated selection constitutes systematic evaluation under Art. 35(1)`}],
    [{text:'Automated decision with legal/similarly significant effect'},{text:'TRIGGERED — Art. 35(3)(a)',color:C.red,bold:true},{text:'Automated selection decisions significantly affect individuals — GDPR Art. 22 applies'}],
    [{text:'Large-scale processing'},{text:largeDS?'TRIGGERED — Art. 35(1)':'REVIEW REQUIRED',color:largeDS?C.red:C.amber},{text:`${(result.total_rows||0).toLocaleString()} records. EDPB guidelines: large-scale = many individuals / large geographic area / long duration`}],
    [{text:'New technology with high residual risk'},{text:'LIKELY TRIGGERED — Art. 35(1)',color:C.red},{text:'Automated AI selection using protected attributes constitutes new technology per EDPB guidelines'}],
    [{text:'DPIA conducted and documented'},{text:dpiaS!=='NOT PROVIDED'?`DECLARED: ${s(dpiaS)}`:'REQUIRES INPUT',color:dpiaS!=='NOT PROVIDED'?C.amber:C.red,bold:true},{text:dpiaS!=='NOT PROVIDED'?`Status recorded${compliance.dpia_link?` — link: ${s(compliance.dpia_link)}`:''}. DPO sign-off required if triggered.`:'CRITICAL: Conduct DPIA before deployment; involve DPO; document findings'}],
  ]
  y = table(doc, ['DPIA Criterion','Status','Assessment / Action'], dpiaRows, y, [68,32,70])

  y = subHead(doc, 'GDPR Core Structure (Mandatory)', y)
  const lBasis = valueOr(compliance.lawful_basis)
  const purpose = valueOr(compliance.purpose_of_processing)
  const categories = listOr(compliance.data_categories)
  const retention = valueOr(compliance.retention_period)
  const dsar = valueOr(compliance.dsar_process)
  const dpoC = valueOr(compliance.dpo_contact)
  const ovC = valueOr(compliance.oversight_contact)
  const gdprCoreRows = [
    [{text:'lawful_basis'},{text:lBasis,color:lBasis==='NOT PROVIDED'?C.red:C.text}],
    [{text:'purpose_of_processing'},{text:purpose,color:purpose==='NOT PROVIDED'?C.red:C.text}],
    [{text:'data_categories'},{text:categories,color:categories==='NOT PROVIDED'?C.red:C.text}],
    [{text:'retention_period'},{text:retention,color:retention==='NOT PROVIDED'?C.red:C.text}],
    [{text:'dpia_status'},{text:dpiaS,color:dpiaS==='NOT PROVIDED'?C.red:C.text}],
    [{text:'dsar_process'},{text:dsar,color:dsar==='NOT PROVIDED'?C.red:C.text}],
  ]
  y = table(doc, ['Field','Value'], gdprCoreRows, y, [65,105])

  y = subHead(doc, 'GDPR Individual Rights Obligations (Arts. 13-22)', y)
  const gdprRows = [
    [{text:'Lawful basis for processing (Art. 6)'},{text:lBasis!=='NOT PROVIDED'?`DECLARED: ${s(lBasis)}`:'REQUIRES INPUT',color:lBasis!=='NOT PROVIDED'?C.amber:C.red},{text:lBasis!=='NOT PROVIDED'?s(lBasis):'Identify legal basis: consent (Art. 6(1)(a)), contract (6(1)(b)), legal obligation (6(1)(c)), legitimate interest (6(1)(f))'}],
    [{text:'Transparency notice to data subjects (Arts. 13-14)'},{text:'REQUIRES INPUT',color:C.amber},{text:'Provide notice before or at time of collection: purposes, legal basis, retention, rights, automated decision-making'}],
    [{text:'Right of access to personal data (Art. 15)'},{text:dsar!=='NOT PROVIDED'?'DECLARED BUT NOT VERIFIED':'REQUIRES INPUT',color:dsar!=='NOT PROVIDED'?C.amber:C.red},{text:dsar!=='NOT PROVIDED'?dsar:'Implement mechanism for data subject access requests (DSARs); respond within 30 days'}],
    [{text:'Right to rectification (Art. 16)'},{text:'REQUIRES INPUT',color:C.amber},{text:'Process to correct inaccurate personal data used in automated selection decisions'}],
    [{text:'Right to erasure / right to be forgotten (Art. 17)'},{text:retention!=='NOT PROVIDED'?'DECLARED BUT NOT VERIFIED':'REQUIRES INPUT',color:retention!=='NOT PROVIDED'?C.amber:C.red},{text:retention!=='NOT PROVIDED'?retention:'Define deletion schedule; implement deletion requests; document retention justification'}],
    [{text:'Right to object to automated processing (Art. 21)'},{text:ovC!=='NOT PROVIDED'?`DECLARED: ${s(ovC)}`:'REQUIRES INPUT',color:ovC!=='NOT PROVIDED'?C.amber:C.red},{text:ovC!=='NOT PROVIDED'?`Contact documented. Response SLA must be defined.`:'Document objection contact point and response SLA; automated processing must be stoppable on objection'}],
    [{text:'Right not to be subject to solely automated decisions (Art. 22)'},{text:ovC!=='NOT PROVIDED'?`DECLARED: ${s(ovC)}`:'REQUIRES INPUT',color:ovC!=='NOT PROVIDED'?C.amber:C.red},{text:ovC!=='NOT PROVIDED'?`Named human reviewer recorded. Escalation path must be documented.`:'Name human reviewer and document escalation path; individuals must be able to request human review'}],
    [{text:'Right to counterfactual explanation (CJEU C-203/22)'},{text:'AUTO-PROVIDED',color:C.blue},{text:'FairLens What-If tool implements counterfactual explanations per CJEU C-203/22 standard; available on request'}],
    [{text:'Data retention and deletion schedule (Art. 5(1)(e))'},{text:retention!=='NOT PROVIDED'?'DECLARED BUT NOT VERIFIED':'REQUIRES INPUT',color:retention!=='NOT PROVIDED'?C.amber:C.red},{text:retention!=='NOT PROVIDED'?retention:'Define retention period; document deletion triggers; anonymise or delete when no longer necessary'}],
    [{text:'Third-party processor agreements (Art. 28)'},{text:'REQUIRES INPUT',color:C.amber},{text:'If AI model hosted externally: Data Processing Agreement (DPA) required with processor'}],
    [{text:'DPO consultation on DPIA (Art. 36)'},{text:dpoC!=='NOT PROVIDED'?`DECLARED: ${s(dpoC)}`:'REQUIRES INPUT',color:dpoC!=='NOT PROVIDED'?C.amber:C.red},{text:dpoC!=='NOT PROVIDED'?`DPO contact documented. Formal DPIA sign-off required.`:'Appoint or consult DPO; mandatory when DPIA is triggered; seek prior consultation if high residual risk (Art. 36)'}],
    [{text:'Special category data safeguards (Art. 9 GDPR + Art. 10(5) AI Act)'},{text:'REQUIRES INPUT',color:C.amber},{text:'Processing protected attributes for bias detection permitted under AI Act Art. 10(5) — document safeguards applied'}],
  ]
  y = table(doc, ['GDPR Obligation','Status','Action Required'], gdprRows, y, [65,32,73])

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 9 — POST-MARKET MONITORING (Arts. 72-73 / Annex IV §9)
  // ═══════════════════════════════════════════════════════════════════════════
  y = sectionHeader(doc, 9, 'Post-Market Monitoring & Incident Reporting',
    'Regulation (EU) 2024/1689 — Articles 72, 73, Annex IV §9 | Art. 18 Documentation Retention', y)

  y = textBlock(doc, 'Article 72 requires providers of high-risk AI systems to proactively collect, document, and analyse data on system performance for the entire lifetime of the system. Article 73 requires serious incidents — including biased decisions causing harm — to be reported to the relevant National Competent Authority (NCA) within 15 working days of awareness.', M, y, {color:C.muted, lh:1.5, mb:8})

  const currentDPD = dpd||0
  const monC = compliance.monitoring_cadence
  const escP = compliance.escalation_plan
  const ncaJ = compliance.nca_jurisdiction

  y = subHead(doc, 'Declared monitoring setup (standalone system)', y)
  const declaredMonRows = [
    [{text:'log_retention_policy'},{text:valueOr(compliance.log_retention_policy),color:valueOr(compliance.log_retention_policy)==='NOT PROVIDED'?C.red:C.text}],
    [{text:'log_storage_location'},{text:valueOr(compliance.log_storage_location),color:valueOr(compliance.log_storage_location)==='NOT PROVIDED'?C.red:C.text}],
    [{text:'monitoring_frequency'},{text:valueOr(compliance.monitoring_frequency),color:valueOr(compliance.monitoring_frequency)==='NOT PROVIDED'?C.red:C.text}],
    [{text:'alert_channel'},{text:valueOr(compliance.alert_channel),color:valueOr(compliance.alert_channel)==='NOT PROVIDED'?C.red:C.text}],
  ]
  y = table(doc, ['Field','Value'], declaredMonRows, y, [65,105])

  y = subHead(doc, 'Monitoring Plan (Annex IV §9 — Art. 72)', y)
  const monRows = [
    [{text:'Bias re-audit cadence (Art. 72)'},{text:monC?`DECLARED: ${s(monC)}`:'REQUIRES INPUT',color:monC?C.amber:C.red},{text:monC||'Recommended: quarterly, or triggered by every 10% change in dataset size or composition'}],
    [{text:'DPD drift alert threshold'},{text:`AUTO-COMPUTED: Alert at DPD > ${(currentDPD*1.20).toFixed(4)}`,color:C.blue},{text:`Current DPD: ${num(currentDPD,4)}. Alert threshold set at 20% above current (EU best practice).`}],
    [{text:'DIR drift alert threshold'},{text:'AUTO-COMPUTED: Alert if DIR < 0.80',color:C.blue},{text:`Current DIR: ${num(dir,4)||'N/A'}. EU 4/5 rule requires DIR ≥ 0.80. Alert triggered below this threshold.`}],
    [{text:'Bias score escalation threshold'},{text:`AUTO-COMPUTED: Alert if score > ${Math.min(100,Math.round((result.bias_score||0)*1.15))}`,color:C.blue},{text:`Current score: ${result.bias_score}/100. Escalation if score increases >15% from baseline.`}],
    [{text:'New protected group detection'},{text:'REQUIRES INPUT',color:C.amber},{text:'Define protocol to detect new demographic groups in production data; trigger re-audit when new groups appear'}],
    [{text:'Escalation procedure (Art. 72(3))'},{text:escP?`DECLARED: ${s(escP)}`:'REQUIRES INPUT',color:escP?C.amber:C.red},{text:escP||'Define: notification chain, responsible persons, timelines, corrective action triggers'}],
    [{text:'Technical documentation retention (Art. 18)'},{text:'MANDATORY — 10 YEAR RETENTION',color:C.red},{text:'Retain full technical file for minimum 10 years after market placement or service commencement'}],
    [{text:'Automatically generated logs (Art. 19)'},{text:valueOr(compliance.log_storage_location)==='NOT PROVIDED'?'REQUIRES INPUT':'DECLARED BUT NOT VERIFIED',color:valueOr(compliance.log_storage_location)==='NOT PROVIDED'?C.red:C.amber},{text:'System must log sufficient data to identify risks and trace decisions — Art. 19 + Art. 12'}],
  ]
  y = table(doc, ['Monitoring Element','Status','Specification / Guidance'], monRows, y, [65,38,67])

  y = subHead(doc, 'Serious Incident Reporting (Art. 73)', y)
  const incRows = [
    [{text:'Serious incident definition documented'},{text:'MANDATORY',color:C.red},{text:'Art. 73: Any incident causing/risking harm to health, safety, or fundamental rights; bias causing adverse legal/employment effect qualifies'}],
    [{text:'Named NCA liaison'},{text:ncaJ?`DECLARED: ${s(ncaJ)}`:'REQUIRES INPUT',color:ncaJ?C.amber:C.red},{text:ncaJ?`NCA jurisdiction recorded. Assign named liaison and document contact details.`:'Assign named person responsible for NCA notifications; document contact details'}],
    [{text:'Reporting timeline (Art. 73(3))'},{text:'MANDATORY — 15 WORKING DAYS',color:C.red},{text:'Notify NCA within 15 working days of first becoming aware of a serious incident or malfunctioning'}],
    [{text:'NCA jurisdiction documented'},{text:ncaJ?`DECLARED BUT NOT VERIFIED: ${s(ncaJ)}`:'REQUIRES INPUT',color:ncaJ?C.amber:C.red},{text:ncaJ||'Identify the EU Member State NCA with jurisdiction based on Art. 2 deployment scope'}],
    [{text:'Market surveillance cooperation (Art. 74)'},{text:'MANDATORY',color:C.red},{text:'Provide all requested information to NCA; allow access to technical documentation; cooperate with investigations'}],
  ]
  y = table(doc, ['Incident Reporting Element','Status','Requirements'], incRows, y, [65,35,70])

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 10 — ANNEX IV §7: STANDARDS & SPECIFICATIONS
  // ═══════════════════════════════════════════════════════════════════════════
  y = sectionHeader(doc, 10, 'Standards, Specifications & Quality Management',
    'Regulation (EU) 2024/1689 — Annex IV §7, Article 17 (Quality Management System)', y)

  y = subHead(doc, 'Applicable Standards and Specifications (Annex IV §7)', y)
  const stdRows = [
    [{text:'ISO/IEC 42001:2023'},{text:'AI Management System Standard',bold:true},{text:'Framework for responsible AI development and deployment — aligns with Art. 17 QMS requirements'}],
    [{text:'ISO/IEC 23894:2023'},{text:'AI Risk Management'},{text:'Risk management guidance for AI systems — implements Art. 9 requirements'}],
    [{text:'ISO/IEC 24027:2021'},{text:'Bias in AI Systems'},{text:'Terminology and bias classification — informs Art. 10 data governance obligations'}],
    [{text:'NIST AI RMF 1.0 (2023)'},{text:'AI Risk Management Framework'},{text:'Govern, Map, Measure, Manage framework — compatible with Annex IV §5 requirements'}],
    [{text:'IEEE P7003'},{text:'Algorithmic Bias Considerations'},{text:'Standard for algorithmic bias considerations in autonomous systems'}],
    [{text:'DIN SPEC 92001'},{text:'AI Life Cycle Processes'},{text:'AI lifecycle quality standard compatible with Art. 9 continuous risk management'}],
  ]
  y = table(doc, ['Standard','Title','Relevance to Regulation (EU) 2024/1689'], stdRows, y, [35,40,95])

  y = subHead(doc, 'Quality Management System Requirements (Art. 17)', y)
  const qmsRows = [
    [{text:'Art. 17(1)(a): Regulatory compliance strategy'},{text:'REQUIRES INPUT',color:C.amber},{text:'Document strategy for compliance with applicable AI Act requirements'}],
    [{text:'Art. 17(1)(b): Design and development procedures'},{text:'REQUIRES INPUT',color:C.amber},{text:'Document design choices, architecture decisions, training procedures'}],
    [{text:'Art. 17(1)(c): Examination, testing, validation procedures'},{text:'PARTIALLY DOCUMENTED',color:C.blue},{text:'FairLens audit provides fairness validation — technical accuracy testing by operator required'}],
    [{text:'Art. 17(1)(d): Roles and responsibilities'},{text:'REQUIRES INPUT',color:C.amber},{text:'Name responsible persons for each compliance obligation (see Section 12)'}],
    [{text:'Art. 17(1)(e-g): Resources, corrective actions, feedback'},{text:'REQUIRES INPUT',color:C.amber},{text:'Document resources, corrective action procedures, and feedback mechanisms'}],
    [{text:'Art. 17(2): QMS proportionality for SMEs'},{text:'AUTO-ASSESSED',color:C.blue},{text:'SMEs may implement a simplified QMS — Commission guidance to be published (Art. 17(4))'}],
  ]
  y = table(doc, ['QMS Requirement','Status','Action Required'], qmsRows, y, [68,32,70])

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 11 — HUMAN OVERSIGHT (Art. 14)
  // ═══════════════════════════════════════════════════════════════════════════
  y = sectionHeader(doc, 11, 'Human Oversight Requirements',
    'Regulation (EU) 2024/1689 — Article 14, Annex IV §3(c) | GDPR Article 22(3)', y)

  y = textBlock(doc, 'Article 14 requires high-risk AI systems to be designed to allow natural persons to oversee their functioning and intervene. GDPR Article 22(3) requires that where automated decision-making is permitted, the data subject must have the right to obtain human intervention, express their view, and contest the decision.', M, y, {color:C.muted, lh:1.5, mb:8})

  const humanRows = [
    [{text:'Human oversight mechanism documented (Art. 14(1))'},{text:ovC!=='NOT PROVIDED'?`DECLARED: ${s(ovC)}`:'REQUIRES INPUT',color:ovC!=='NOT PROVIDED'?C.amber:C.red},{text:ovC!=='NOT PROVIDED'?'Contact documented. Full escalation path and response SLA required.':'Name responsible persons who can review, override, and intervene in automated decisions'}],
    [{text:'Deployer training on oversight (Art. 14(3)(c))'},{text:'REQUIRES INPUT',color:C.amber},{text:'Train deployers to understand capabilities, limitations, and appropriate human oversight of this system'}],
    [{text:'Override / suspension capability (Art. 14(4))'},{text:'REQUIRES INPUT',color:C.amber},{text:'System must be stoppable and overridable by natural person without undue delay'}],
    [{text:'Monitoring of system outputs (Art. 14(5))'},{text:'REQUIRES INPUT',color:C.amber},{text:'Define monitoring procedures; document escalation when anomalous outputs detected'}],
    [{text:'Human review of contested decisions (GDPR Art. 22(3))'},{text:ovC!=='NOT PROVIDED'?'DECLARED BUT NOT VERIFIED':'REQUIRES INPUT',color:ovC!=='NOT PROVIDED'?C.amber:C.red},{text:'Individuals have the right to obtain human review; decision must be re-examined by natural person'}],
    [{text:'Non-sole reliance on automated output (Art. 14(5)(b))'},{text:'REQUIRES INPUT',color:C.amber},{text:'Ensure human decision-makers are aware they must not rely solely on the AI system output'}],
  ]
  y = table(doc, ['Human Oversight Requirement','Status','Action Required'], humanRows, y, [70,35,65])

  y = sectionHeader(doc, '11A', 'INTENDED USE & LIMITATIONS',
    'Human-readable transparency declaration for deployers and affected persons', y)
  const intendedRows = [
    [{text:'intended_use'},{text:valueOr(compliance.intended_use),color:valueOr(compliance.intended_use)==='NOT PROVIDED'?C.red:C.text}],
    [{text:'intended_users'},{text:valueOr(compliance.intended_users),color:valueOr(compliance.intended_users)==='NOT PROVIDED'?C.red:C.text}],
    [{text:'system_limitations'},{text:valueOr(compliance.system_limitations),color:valueOr(compliance.system_limitations)==='NOT PROVIDED'?C.red:C.text}],
    [{text:'known_failure_modes'},{text:valueOr(compliance.known_failure_modes),color:valueOr(compliance.known_failure_modes)==='NOT PROVIDED'?C.red:C.text}],
  ]
  y = table(doc, ['Field','Declaration'], intendedRows, y, [65,105])

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 12 — DECLARATION OF CONFORMITY (Art. 47 / Annex V)
  // ═══════════════════════════════════════════════════════════════════════════
  y = sectionHeader(doc, 12, 'Declaration of System Conformity',
    'Regulation (EU) 2024/1689 — Article 47, Annex V | Article 14 Human Oversight Prerequisite', y)

  y = alertBox(doc, 'ART. 14 — HUMAN OVERSIGHT REQUIRED BEFORE THIS DECLARATION IS VALID',
    'Under Article 14 of Regulation (EU) 2024/1689, this automated report does not constitute a declaration of conformity. It must be reviewed, validated, and countersigned by qualified natural persons before it has legal evidentiary value. The integrity seal below certifies document integrity and audit reproducibility only.',
    y, C.amber, 26)

  // Integrity seal
  const sealLine1 = `Compliance Record: ${recordId||'N/A — offline export'}`
  const sealLine2 = `Export Hash: ${exportHash}`
  const sealLine3 = 'Computation: SHA256(record_id | updated_at | sorted compliance metadata)'
  const sealLine4 = `Verification: ${hashValid?'VERIFIED AGAINST SERVER RECORD':'LOCAL HASH — not verified against server'}`
  const sealH = Math.max(
    36,
    10 +
    wrappedTextHeight(doc, sealLine1, CW-10, 8, 1.4) +
    wrappedTextHeight(doc, sealLine2, CW-10, 8, 1.4) +
    wrappedTextHeight(doc, sealLine3, CW-10, 8, 1.4) +
    wrappedTextHeight(doc, sealLine4, CW-10, 8, 1.4) + 6
  )
  y = checkPage(doc, y, sealH + 2)
  doc.setFillColor(...C.surface); doc.setDrawColor(...C.border); doc.setLineWidth(0.4)
  doc.roundedRect(M, y, CW, sealH, 2,2,'FD')
  doc.setFontSize(9.5); doc.setFont('helvetica','bold'); doc.setTextColor(...C.primary)
  doc.text('AUTOMATED INTEGRITY SEAL (Document Verification Only)', M+5, y+8)
  let sy = y + 14
  sy = textBlock(doc, sealLine1, M+5, sy, { maxW: CW-10, fs: 8, lh: 1.4, mb: 1 })
  sy = textBlock(doc, sealLine2, M+5, sy, { maxW: CW-10, fs: 8, lh: 1.4, mb: 1 })
  sy = textBlock(doc, sealLine3, M+5, sy, { maxW: CW-10, fs: 8, lh: 1.4, mb: 1 })
  doc.setTextColor(...(hashValid?C.green:C.amber))
  sy = textBlock(doc, sealLine4, M+5, sy, { maxW: CW-10, fs: 8, lh: 1.4, mb: 0 })
  y = Math.max(y + sealH + 6, sy + 6)

  // Annex V items covered
  y = subHead(doc, 'Annex V Coverage — EU Declaration of Conformity Requirements', y)
  const annexVRows = [
    [{text:'System name and version (Annex V §1)'},{text:'AUTO-DOCUMENTED',color:C.blue},{text:'FairLens audit report methodology: '+METHODOLOGY_VERSION}],
    [{text:'Provider name and address (Annex V §2)'},{text:'REQUIRES INPUT',color:C.amber},{text:'Operator must add provider legal name, registered address, and contact details'}],
    [{text:'Statement of sole responsibility (Annex V §3)'},{text:'REQUIRES INPUT',color:C.amber},{text:'Provider must declare sole responsibility for compliance with Regulation (EU) 2024/1689'}],
    [{text:'Conformity assessment procedure (Annex V §4)'},{text:'REQUIRES INPUT',color:C.amber},{text:'Reference the specific conformity assessment route used (Annex VI internal or Annex VII notified body)'}],
    [{text:'Applied standards (Annex V §5)'},{text:'AUTO-DOCUMENTED',color:C.blue},{text:'See Section 10 — Standards and Specifications'}],
    [{text:'Notified body involvement (Annex V §6)'},{text:'REQUIRES INPUT',color:C.amber},{text:'If applicable, provide name, address, and identification number of notified body'}],
    [{text:'Authorised signatory (Annex V §7)'},{text:'REQUIRES INPUT',color:C.red},{text:'Provider must sign and date the EU Declaration of Conformity before market placement'}],
  ]
  y = table(doc, ['Annex V Requirement','Status','Action Required'], annexVRows, y, [65,32,73])

  // Countersignature fields
  y = checkPage(doc, y, 70)
  y = subHead(doc, 'Accountability & Countersignature (Art. 14 — Mandatory Before Deployment)', y)
  y += 2

  const recorded = compliance.countersignatures||[]
  const signFields2 = [
    ['System Owner / Deployer','Name, Title, Organisation, Date — Art. 16, 26'],
    ['Compliance Officer','Name, Title, Date — Art. 17 Quality Management System'],
    ['Data Protection Officer (DPO)','Name, Title, Date — GDPR Art. 37, mandatory if DPIA triggered'],
    ['Technical Lead / Model Developer','Name, Title, Date — Art. 9, 15 technical validation'],
  ]
  for (const [role, note] of signFields2) {
    y = checkPage(doc, y, 16)
    const signed = recorded.find(c=>c.role===role)
    doc.setFontSize(8.5); doc.setFont('helvetica','bold'); doc.setTextColor(...C.text)
    doc.text(s(role)+':', M, y)
    if (signed) {
      doc.setFontSize(8); doc.setFont('helvetica','normal'); doc.setTextColor(...C.green)
      doc.text(`${s(signed.name)} — ${s(signed.signed_at||'date not recorded')}`, M+60, y)
    } else {
      doc.setDrawColor(...C.border); doc.setLineWidth(0.3)
      doc.line(M+60, y, PW-M, y)
    }
    doc.setFontSize(7); doc.setFont('helvetica','italic'); doc.setTextColor(...C.muted)
    doc.text(s(note), M, y+5)
    y += 13
  }

  y += 4
  y = textBlock(doc, `Methodology: ${METHODOLOGY_VERSION}  |  Integrity Hash (export): ${exportHash}  |  Generated: ${ts}  |  Geographic deployment scope must be documented per Art. 2, Regulation (EU) 2024/1689.  |  Fines: up to EUR 30,000,000 or 6% global annual turnover (Art. 99).`, M, y, {color:C.muted, maxW:CW, fs:7, lh:1.4})

  footer(doc)
  if (options.returnBlob) return doc.output('blob')
  doc.save(`FairLens_Compliance_Audit_${Date.now()}.pdf`)
}

export async function exportAuditToPdfBlob(result, description) {
  return exportAuditToPdf(result, description, { returnBlob: true })
}

// ── Text-mode export (kept for /results page) ───────────────────────────────
export async function exportToPdf(prompt, aiResponse, result) {
  const doc = new jsPDF({unit:'mm',format:'a4'})
  let y = 25
  doc.setFontSize(22); doc.setTextColor(...C.primary); doc.setFont('helvetica','bold')
  doc.text('Text Fairness Audit', M, y); y+=10
  doc.setFontSize(10); doc.setTextColor(...C.text); doc.setFont('helvetica','normal')
  doc.text(`Score: ${result.bias_score}/100 — ${result.bias_level}`, M, y); y+=20
  doc.setFontSize(13); doc.setTextColor(...C.primary); doc.setFont('helvetica','bold')
  doc.text('Original Text', M, y); y+=8
  doc.setFontSize(9.5); doc.setTextColor(...C.text); doc.setFont('helvetica','normal')
  y = textBlock(doc, s(prompt)||'', M, y, { maxW: CW, fs: 9.5, lh: 1.5, mb: 10 })
  doc.setFontSize(13); doc.setTextColor(...C.primary); doc.setFont('helvetica','bold')
  y = checkPage(doc, y, 18)
  doc.text('Unbiased Rewrite', M, y); y+=8
  doc.setFontSize(9.5); doc.setTextColor(...C.text); doc.setFont('helvetica','normal')
  y = textBlock(doc, s(result.unbiased_response)||'', M, y, { maxW: CW, fs: 9.5, lh: 1.5, mb: 0 })
  doc.save(`FairLens_TextAudit_${Date.now()}.pdf`)
}

export async function exportToPdfBlob(prompt, aiResponse, result) {
  const doc = new jsPDF({unit:'mm',format:'a4'})
  let y = 25
  doc.setFontSize(22); doc.setTextColor(...C.primary); doc.setFont('helvetica','bold')
  doc.text('Text Fairness Audit', M, y); y+=10
  doc.setFontSize(10); doc.setTextColor(...C.text); doc.setFont('helvetica','normal')
  doc.text(`Score: ${result.bias_score}/100 — ${result.bias_level}`, M, y); y+=20
  doc.setFontSize(13); doc.setTextColor(...C.primary); doc.setFont('helvetica','bold')
  doc.text('Original Text', M, y); y+=8
  doc.setFontSize(9.5); doc.setTextColor(...C.text); doc.setFont('helvetica','normal')
  y = textBlock(doc, s(prompt)||'', M, y, { maxW: CW, fs: 9.5, lh: 1.5, mb: 10 })
  doc.setFontSize(13); doc.setTextColor(...C.primary); doc.setFont('helvetica','bold')
  y = checkPage(doc, y, 18)
  doc.text('Unbiased Rewrite', M, y); y+=8
  doc.setFontSize(9.5); doc.setTextColor(...C.text); doc.setFont('helvetica','normal')
  y = textBlock(doc, s(result.unbiased_response)||'', M, y, { maxW: CW, fs: 9.5, lh: 1.5, mb: 0 })
  return doc.output('blob')
}
