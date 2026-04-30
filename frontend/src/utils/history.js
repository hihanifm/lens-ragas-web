import { uuid } from './uuid'

const STORAGE_KEY = 'lens-ragas-web:history:v1'
const MAX_RUNS = 20

export function loadHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveRunToHistory(run) {
  const entry = {
    id: run?.meta?.id || uuid(),
    createdAt: run?.meta?.createdAt || new Date().toISOString(),
    meta: run?.meta || {},
    results: run?.results || run,
  }

  const prev = loadHistory()
  const next = [entry, ...prev.filter(r => r.id !== entry.id)].slice(0, MAX_RUNS)

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch (e) {
    // If storage is full or blocked, fail silently (history is a convenience).
    // Still allow the current in-memory results flow to succeed.
    console.warn('Failed to save history:', e)
  }

  return entry
}

export function deleteRunFromHistory(runId) {
  const prev = loadHistory()
  const next = prev.filter(r => r.id !== runId)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  return next
}

export function clearHistory() {
  localStorage.removeItem(STORAGE_KEY)
}

