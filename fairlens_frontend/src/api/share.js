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
    return JSON.parse(decodeURIComponent(atob(encoded)))
  } catch { return null }
}

export function buildShareUrl(data) {
  const encoded = encodeShareData(data)
  if (!encoded) return null

  // Route audit shares to /audit-results, text shares to /results
  const route = data.type === 'audit' ? '/audit-results' : '/results'
  return `${window.location.origin}${route}?shared=${encoded}`
}
