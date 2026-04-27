function normalizeBasePath(raw) {
  const v = (raw || '').trim()
  if (!v || v === '/') return ''
  const withLeading = v.startsWith('/') ? v : `/${v}`
  return withLeading.endsWith('/') ? withLeading.slice(0, -1) : withLeading
}

// Vite exposes env vars under `import.meta.env`.
// We intentionally keep this tiny and dependency-free.
export const BASE_PATH = normalizeBasePath(import.meta.env.VITE_BASE_PATH)
export const API_BASE = `${BASE_PATH}/api`

