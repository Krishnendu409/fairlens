import axios from 'axios'

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:8000',
  headers: { 'Content-Type': 'application/json' },
})

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export function parseCsvHeaders(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const firstLine = e.target.result.split('\n')[0]
      const headers = firstLine.split(',').map(h => h.trim().replace(/^"|"$/g, ''))
      resolve(headers)
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

export async function sampleAudit(datasetName) {
  const { data } = await api.get(`/sample-audit/${datasetName}`)
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
