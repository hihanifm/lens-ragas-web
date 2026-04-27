import { useEffect, useMemo, useState } from 'react'

const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'
const GITHUB_URL = typeof __GITHUB_URL__ !== 'undefined' ? __GITHUB_URL__ : null

export default function Footer() {
  const [api, setApi] = useState({ status: 'checking', latencyMs: null, checkedAt: null })

  useEffect(() => {
    let cancelled = false

    async function check() {
      const t0 = performance.now()
      try {
        const res = await fetch('/api/health', { cache: 'no-store' })
        const t1 = performance.now()
        if (!cancelled) {
          setApi({
            status: res.ok ? 'online' : 'offline',
            latencyMs: Math.round(t1 - t0),
            checkedAt: new Date().toISOString(),
          })
        }
      } catch {
        const t1 = performance.now()
        if (!cancelled) {
          setApi({
            status: 'offline',
            latencyMs: Math.round(t1 - t0),
            checkedAt: new Date().toISOString(),
          })
        }
      }
    }

    check()
    const id = setInterval(check, 15000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  const apiPill = useMemo(() => {
    const color =
      api.status === 'online'
        ? 'bg-green-50 text-green-700 border-green-200'
        : api.status === 'offline'
          ? 'bg-red-50 text-red-700 border-red-200'
          : 'bg-gray-50 text-gray-700 border-gray-200'

    const label =
      api.status === 'online' ? 'API online' : api.status === 'offline' ? 'API offline' : 'API checking'

    return { color, label }
  }, [api.status])

  return (
    <footer className="border-t border-gray-200 bg-white">
      <div className="max-w-4xl mx-auto px-6 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
          <span className={`inline-flex items-center gap-2 px-2 py-1 rounded-full border ${apiPill.color}`}>
            <span
              className={`w-1.5 h-1.5 rounded-full ${api.status === 'online' ? 'bg-green-500' : api.status === 'offline' ? 'bg-red-500' : 'bg-gray-400'}`}
            />
            <span className="font-medium">{apiPill.label}</span>
            {api.latencyMs != null && <span className="text-gray-500">{api.latencyMs}ms</span>}
          </span>

          <span className="text-gray-300">·</span>
          <span>
            Version <span className="font-mono text-gray-700">{APP_VERSION}</span>
          </span>
        </div>

        <div className="flex items-center gap-3 text-xs">
          {GITHUB_URL && (
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="text-gray-600 hover:text-gray-900 hover:underline"
            >
              GitHub
            </a>
          )}
        </div>
      </div>
    </footer>
  )
}

