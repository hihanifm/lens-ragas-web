import axios from 'axios'

import { API_BASE } from '../utils/basePath'

const api = axios.create({ baseURL: API_BASE })

export async function fetchConfig() {
  const { data } = await api.get('/config')
  return data
}

export async function parseFile(file) {
  const form = new FormData()
  form.append('file', file)
  const { data } = await api.post('/parse', form)
  return data
}

export function streamEvaluation(req, { onStart, onRow, onComplete, onError }) {
  const es = new EventSource(
    `${API_BASE}/evaluate?` + new URLSearchParams({ _dummy: Date.now() })
  )

  // EventSource doesn't support POST; use fetch with ReadableStream instead
  es.close()

  const ctrl = new AbortController()

  fetch(`${API_BASE}/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal: ctrl.signal,
  }).then(async res => {
    if (!res.ok) {
      const text = await res.text()
      onError(text)
      return
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      const parts = buf.split('\n\n')
      buf = parts.pop()

      for (const part of parts) {
        if (!part.trim()) continue
        const lines = part.split('\n')
        let event = 'message', dataStr = ''
        for (const line of lines) {
          if (line.startsWith('event: ')) event = line.slice(7).trim()
          if (line.startsWith('data: ')) dataStr = line.slice(6).trim()
        }
        try {
          const data = JSON.parse(dataStr)
          if (event === 'start') onStart(data)
          else if (event === 'row') onRow(data)
          else if (event === 'complete') onComplete(data)
          else if (event === 'error') onError(data.message)
        } catch { /* ignore parse errors */ }
      }
    }
  }).catch(err => {
    if (err.name !== 'AbortError') onError(err.message)
  })

  return () => ctrl.abort()
}
