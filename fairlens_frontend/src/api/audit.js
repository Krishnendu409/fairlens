import axios from 'axios'

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:8000',
  headers: { 'Content-Type': 'application/json' },
})

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result)
      let binary = ''
      const chunkSize = 0x8000
      for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize)
        binary += String.fromCharCode(...chunk)
      }
      resolve(btoa(binary))
    }
    reader.onerror = reject
    reader.readAsArrayBuffer(file)
  })
}

export function parseCsvHeaders(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const text = String(e.target.result || '')
      const firstDataLine = text
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(line => line.length > 0)
      if (!firstDataLine) {
        resolve([])
        return
      }

      const headers = []
      let current = ''
      let inQuotes = false
      for (let i = 0; i < firstDataLine.length; i += 1) {
        const ch = firstDataLine[i]
        if (ch === '"') {
          if (inQuotes && firstDataLine[i + 1] === '"') {
            current += '"'
            i += 1
          } else {
            inQuotes = !inQuotes
          }
          continue
        }
        if (ch === ',' && !inQuotes) {
          headers.push(current.trim())
          current = ''
          continue
        }
        current += ch
      }
      headers.push(current.trim())

      const cleaned = headers
        .map(h => h.replace(/^"(.*)"$/, '$1').trim())
        .filter(Boolean)

      resolve(cleaned)
    }
    reader.onerror = reject
    reader.readAsText(file)
  })
}

export async function auditDataset({
  file, description, targetColumn, predictionColumn,
  sensitiveColumn, sensitiveColumn2
}) {
  const base64 = await fileToBase64(file)
  const { data } = await api.post('/audit-dataset', {
    dataset: base64,
    description: description || '',
    target_column: targetColumn || null,
    prediction_column: predictionColumn || null,
    sensitive_column: sensitiveColumn || null,
    sensitive_column_2: sensitiveColumn2 || null,
  })
  return data
}

export async function getAuditResultById(auditId) {
  const { data } = await api.get(`/audit-results/${encodeURIComponent(auditId)}`)
  return data
}

export async function sendChatMessage({ datasetDescription, auditSummary, conversation, message }) {
  const { data } = await api.post('/audit-chat', {
    dataset_description: datasetDescription,
    audit_summary: auditSummary,
    conversation,
    message,
  })
  return data.reply
}
