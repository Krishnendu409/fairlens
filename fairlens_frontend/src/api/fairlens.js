import axios from 'axios'

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:8000',
  headers: { 'Content-Type': 'application/json' },
})

export async function analyseText(prompt, aiResponse, options = {}) {
  const { data } = await api.post('/analyse', {
    prompt,
    ai_response: aiResponse,
    privacy_mode: !!options.privacyMode,
    dataset: options.dataset || null,
    target_column: options.targetColumn || null,
    prediction_column: options.predictionColumn || null,
    protected_attribute: options.protectedAttribute || null,
  })
  return data
}
