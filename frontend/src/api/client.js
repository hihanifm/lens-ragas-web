import axios from 'axios'

import { API_BASE } from '../utils/basePath'

const api = axios.create({ baseURL: API_BASE })

/** Up to 5 retries after the first attempt; delays 10s, 20s, 40s, 80s, 160s (exponential from 10s). */
const TRANSIENT_RETRY_COUNT = 5
const TRANSIENT_RETRY_DELAYS_MS = Array.from(
  { length: TRANSIENT_RETRY_COUNT },
  (_, i) => 10_000 * 2 ** i,
)

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isTransientHttpStatus(status) {
  return status === 429 || status >= 500
}

function isRetryableAxiosError(e) {
  if (!axios.isAxiosError(e)) return false
  if (!e.response) return true
  return isTransientHttpStatus(e.response.status)
}

/**
 * Run `fn` once, then on transient/network errors retry up to 5 times with exponential backoff from 10s.
 */
export async function retryTransientRequest(fn) {
  let lastErr
  for (let attempt = 0; attempt <= TRANSIENT_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      const canRetry = isRetryableAxiosError(e)
      if (!canRetry || attempt >= TRANSIENT_RETRY_DELAYS_MS.length) {
        throw lastErr
      }
      await sleep(TRANSIENT_RETRY_DELAYS_MS[attempt])
    }
  }
  throw lastErr
}

export function getApiErrorHttpStatus(e) {
  return axios.isAxiosError(e) ? e.response?.status : undefined
}

export function getApiErrorDetail(e) {
  if (axios.isAxiosError(e) && e.response?.data != null) {
    const d = e.response.data.detail
    if (typeof d === 'string') return d
    if (Array.isArray(d)) {
      return d
        .map(x => (typeof x === 'object' && x?.msg != null ? String(x.msg) : JSON.stringify(x)))
        .join('; ')
    }
    if (typeof d === 'object') return JSON.stringify(d)
    if (typeof e.response.data === 'string') return e.response.data
  }
  if (e instanceof Error) return e.message
  return String(e)
}

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

export async function applyParseColumnMap({ file_id, column_map }) {
  const { data } = await api.post('/parse/map', { file_id, column_map })
  return data
}

export async function fetchOllamaModels(baseUrl) {
  const { data } = await api.get('/ollama/models', { params: { base_url: baseUrl } })
  return data?.models || []
}

export async function fetchOpenAIModels(apiKey, baseUrl) {
  const params = {}
  const u = typeof baseUrl === 'string' ? baseUrl.trim() : ''
  if (u) params.base_url = u
  const { data } = await api.get('/openai/models', {
    params,
    headers: apiKey ? { 'X-OpenAI-Api-Key': apiKey } : undefined,
  })
  return data?.models || []
}

export async function startEvaluationJob(req) {
  const { data } = await retryTransientRequest(() => api.post('/evaluate/start', req))
  return data?.job_id
}

export async function fetchEvaluationResult(jobId) {
  const { data } = await retryTransientRequest(() => api.get(`/evaluate/result/${jobId}`))
  return data
}

export async function cancelEvaluationJob(jobId) {
  const { data } = await api.post(`/evaluate/cancel/${jobId}`)
  return data
}

export async function fetchServerRuns({ project, limit = 50, offset = 0 } = {}) {
  const params = { limit, offset }
  if (project) params.project = project
  const { data } = await api.get('/runs', { params })
  return data?.runs || []
}

export async function deleteServerRun(jobId) {
  const { data } = await api.delete(`/runs/${jobId}`)
  return data
}

export async function downloadScoredXlsx(jobId) {
  const res = await fetch(`${API_BASE}/export/scored-xlsx/${jobId}`, { method: 'GET' })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || 'Failed to download scored workbook')
  }
  const blob = await res.blob()
  const cd = res.headers.get('content-disposition') || ''
  const m = /filename=\"?([^\";]+)\"?/i.exec(cd)
  const filename = m?.[1] || `scored-${jobId}.xlsx`
  return { blob, filename }
}

export function streamEvaluationJob(jobId, { onStart, onRow, onComplete, onError }) {
  const ctrl = new AbortController()

  ;(async () => {
    let lastFailMsg = ''

    for (let attempt = 0; attempt <= TRANSIENT_RETRY_DELAYS_MS.length; attempt++) {
      if (ctrl.signal.aborted) return

      try {
        const res = await fetch(`${API_BASE}/evaluate/stream/${jobId}`, {
          method: 'GET',
          headers: { Accept: 'text/event-stream' },
          signal: ctrl.signal,
        })

        if (!res.ok) {
          const text = await res.text()
          lastFailMsg = text || `HTTP ${res.status}`
          const retry = isTransientHttpStatus(res.status) && attempt < TRANSIENT_RETRY_DELAYS_MS.length
          if (retry) {
            await sleep(TRANSIENT_RETRY_DELAYS_MS[attempt])
            continue
          }
          onError(lastFailMsg)
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
            let event = 'message',
              dataStr = ''
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
            } catch {
              /* ignore parse errors */
            }
          }
        }

        return
      } catch (err) {
        if (err.name === 'AbortError') return
        lastFailMsg = err.message || String(err)
        if (attempt < TRANSIENT_RETRY_DELAYS_MS.length) {
          await sleep(TRANSIENT_RETRY_DELAYS_MS[attempt])
          continue
        }
        onError(lastFailMsg)
      }
    }
  })()

  return () => ctrl.abort()
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
