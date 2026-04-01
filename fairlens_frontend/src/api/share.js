/**
 * share.js
 * Encodes/decodes result data as a URL parameter for sharing.
 * Supports both text analysis (/results) and audit results (/audit-results).
 */

export function encodeShareData(data) {
  try {
    const json = JSON.stringify(data)
    return btoa(encodeURIComponent(json))
  } catch { return null }
}

export function decodeShareData(encoded) {
  try {
    return { data: JSON.parse(decodeURIComponent(atob(encoded))), error: null }
  } catch {
    return { data: null, error: 'Invalid or corrupted shared link.' }
  }
}

export function buildShareUrl(dataOrAuditId, options = {}) {
  if (typeof dataOrAuditId === 'string' && dataOrAuditId.trim()) {
    return `${window.location.origin}/audit-results?id=${encodeURIComponent(dataOrAuditId.trim())}`
  }

  if (options.forceAuditId) return null

  const encoded = encodeShareData(dataOrAuditId)
  if (!encoded) return null

  // Route audit shares to /audit-results, text shares to /results
  const route = dataOrAuditId.type === 'audit' ? '/audit-results' : '/results'
  return `${window.location.origin}${route}?shared=${encoded}`
}
