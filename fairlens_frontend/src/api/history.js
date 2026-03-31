const TEXT_KEY = 'fairlens_history'
const AUDIT_KEY = 'fairlens_audit_history'
const MAX = 20

function get(key) {
  try { return JSON.parse(localStorage.getItem(key) || '[]') } catch { return [] }
}
function save(key, arr) {
  localStorage.setItem(key, JSON.stringify(arr))
}

// ── Text history ──────────────────────────────────────────────────────────
export function getHistory() { return get(TEXT_KEY) }
export function saveToHistory(entry) {
  const h = getHistory(); h.unshift(entry)
  if (h.length > MAX) h.splice(MAX)
  save(TEXT_KEY, h)
}
export function clearHistory() { localStorage.removeItem(TEXT_KEY) }
export function deleteHistoryItem(id) {
  save(TEXT_KEY, getHistory().filter(h => h.id !== id))
}

// ── Audit history ─────────────────────────────────────────────────────────
export function getAuditHistory() { return get(AUDIT_KEY) }
export function saveToAuditHistory(entry) {
  const h = getAuditHistory(); h.unshift(entry)
  if (h.length > MAX) h.splice(MAX)
  save(AUDIT_KEY, h)
}
export function clearAuditHistory() { localStorage.removeItem(AUDIT_KEY) }
export function deleteAuditHistoryItem(id) {
  save(AUDIT_KEY, getAuditHistory().filter(h => h.id !== id))
}

// ── Shared ────────────────────────────────────────────────────────────────
export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
}
