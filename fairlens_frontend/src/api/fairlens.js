import axios from 'axios'

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:8000',
  headers: { 'Content-Type': 'application/json' },
})

export async function analyseText(prompt, aiResponse, privacyMode = false) {
  const { data } = await api.post('/analyse', {
    prompt,
    ai_response: aiResponse,
    privacy_mode: !!privacyMode,
  })
  return data
}
