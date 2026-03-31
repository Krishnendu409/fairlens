import axios from 'axios'

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:8000',
  headers: { 'Content-Type': 'application/json' },
})

export async function createComplianceSnapshot(payload) {
  const { data } = await api.post('/compliance-records/snapshot', payload)
  return data
}

export async function updateComplianceRecord(recordId, payload) {
  const { data } = await api.patch(`/compliance-records/${recordId}`, payload)
  return data
}

export async function fetchComplianceRecord(recordId) {
  const { data } = await api.get(`/compliance-records/${recordId}`)
  return data
}
