import { useState, useRef, useEffect } from 'react'
import { fetchConfig, fetchOllamaModels, fetchOpenAIModels } from '../api/client'
import { loadHistory } from '../utils/history'

const METRIC_LABELS = {
  faithfulness: 'Faithfulness',
  answer_relevancy: 'Answer Relevancy',
  context_precision: 'Context Precision',
  context_recall: 'Context Recall',
}

const METRIC_DESC = {
  faithfulness: 'Is the answer grounded in the retrieved context?',
  answer_relevancy: 'Is the answer relevant to the question?',
  context_precision: 'Are the retrieved chunks relevant? (needs ground_truth)',
  context_recall: 'Did retrieval cover what was needed? (needs ground_truth)',
}

export default function Configure({ parsedFile, onStartRun, onBack }) {
  const [provider, setProvider] = useState('ollama')
  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434')

  const [ollamaModel, setOllamaModel] = useState('llama3.2')
  const [ollamaModels, setOllamaModels] = useState([])
  const [ollamaModelsStatus, setOllamaModelsStatus] = useState({ loading: false, error: null })
  const [openaiKey, setOpenaiKey] = useState('')
  const [openaiModel, setOpenaiModel] = useState('gpt-4o-mini')
  const [openaiModels, setOpenaiModels] = useState([])
  const [openaiModelsStatus, setOpenaiModelsStatus] = useState({ loading: false, error: null })
  const [selectedMetrics, setSelectedMetrics] = useState(parsedFile.available_metrics)
  const [error, setError] = useState(null)
  const [starting, setStarting] = useState(false)
  const startedCountRef = useRef(0)
  const [activeRunId, setActiveRunId] = useState(null)
  const [runPoll, setRunPoll] = useState(0)

  useEffect(() => {
    fetchConfig().then(cfg => {
      setProvider(cfg.llm_provider || 'ollama')
      if (cfg.ollama_base_url) setOllamaUrl(cfg.ollama_base_url)
      if (cfg.ollama_model) setOllamaModel(cfg.ollama_model)
      if (cfg.openai_api_key) setOpenaiKey(cfg.openai_api_key)
      if (cfg.openai_model) setOpenaiModel(cfg.openai_model)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    if (provider !== 'ollama') return
    let cancelled = false
    setOllamaModelsStatus({ loading: true, error: null })
    fetchOllamaModels(ollamaUrl)
      .then(models => {
        if (cancelled) return
        setOllamaModels(Array.isArray(models) ? models : [])
        setOllamaModelsStatus({ loading: false, error: null })
      })
      .catch(err => {
        if (cancelled) return
        setOllamaModels([])
        setOllamaModelsStatus({
          loading: false,
          error: err?.response?.data?.detail || err?.message || 'Failed to load models',
        })
      })
    return () => {
      cancelled = true
    }
  }, [provider, ollamaUrl])

  useEffect(() => {
    if (provider !== 'openai') return
    const key = String(openaiKey || '').trim()
    if (!key) {
      setOpenaiModels([])
      setOpenaiModelsStatus({ loading: false, error: null })
      return
    }

    let cancelled = false
    setOpenaiModelsStatus({ loading: true, error: null })

    const t = setTimeout(() => {
      fetchOpenAIModels(key)
        .then(models => {
          if (cancelled) return
          setOpenaiModels(Array.isArray(models) ? models : [])
          setOpenaiModelsStatus({ loading: false, error: null })
        })
        .catch(err => {
          if (cancelled) return
          setOpenaiModels([])
          setOpenaiModelsStatus({
            loading: false,
            error: err?.response?.data?.detail || err?.message || 'Failed to load models',
          })
        })
    }, 400) // small debounce for typing

    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [provider, openaiKey])

  useEffect(() => {
    if (!activeRunId) return
    const tick = () => {
      const run = loadHistory().find(r => r.id === activeRunId)
      setRunPoll(p => p + 1)
      if (!run) return
      const s = run?.meta?.status
      if (s && s !== 'running') {
        setActiveRunId(null)
      }
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [activeRunId])

  function toggleMetric(m) {
    setSelectedMetrics(prev =>
      prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m]
    )
  }

  async function handleRun() {
    if (!selectedMetrics.length) return
    setError(null)
    setStarting(true)
    startedCountRef.current += 1

    const req = {
      file_id: parsedFile.file_id,
      metrics: selectedMetrics,
      llm_provider: provider,
      ollama_base_url: ollamaUrl,
      ollama_model: ollamaModel,
      openai_api_key: openaiKey || undefined,
      openai_model: openaiModel,
    }
    const meta = {
      llm_provider: provider,
      provider,
      ollama_base_url: provider === 'ollama' ? ollamaUrl : undefined,
      ollama_model: provider === 'ollama' ? ollamaModel : undefined,
      openai_model: provider === 'openai' ? openaiModel : undefined,
      file_id: parsedFile?.file_id,
      row_count: parsedFile?.row_count,
      format: parsedFile?.format,
      input_filename: parsedFile?.input_filename,
      lens_metadata: parsedFile?.lens_metadata,
      metrics: selectedMetrics,
    }

    try {
      const out = await onStartRun?.(req, meta)
      if (out?.runId) setActiveRunId(out.runId)
    } catch (e) {
      setError(e?.response?.data?.detail || e.message || String(e))
    } finally {
      setStarting(false)
    }
  }

  void runPoll
  const activeRun = activeRunId ? loadHistory().find(r => r.id === activeRunId) : null
  const showRunBanner = activeRun && activeRun?.meta?.status === 'running'

  return (
    <div className="space-y-6">
      {/* File summary */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-700">File loaded</p>
            <p className="text-sm text-gray-500 mt-0.5">
              {parsedFile.row_count} rows &middot; format:{' '}
              <span className="font-mono">{parsedFile.format}</span>
            </p>
          </div>
          <button onClick={onBack} className="text-sm text-blue-600 hover:underline">
            Change file
          </button>
        </div>
        {parsedFile.format === 'lens' && (
          <div className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
            LENS export detected — no <code>answer</code> column. Only context metrics are available.
          </div>
        )}
        {parsedFile?.lens_metadata && (
          <div className="mt-3 text-xs bg-gray-50 border border-gray-200 rounded px-3 py-2">
            <p className="font-medium text-gray-700 mb-1">Export metadata</p>
            <div className="text-gray-600 space-y-1">
              {parsedFile.lens_metadata?.exported_at && (
                <div>
                  <span className="text-gray-500">exported_at</span>{' '}
                  <span className="font-mono text-gray-700">{parsedFile.lens_metadata.exported_at}</span>
                </div>
              )}
              {parsedFile.lens_metadata?.k != null && (
                <div>
                  <span className="text-gray-500">k</span>{' '}
                  <span className="font-mono text-gray-700">{String(parsedFile.lens_metadata.k)}</span>
                </div>
              )}
              {parsedFile.lens_metadata?.pipeline && typeof parsedFile.lens_metadata.pipeline === 'object' && (
                <div>
                  <span className="text-gray-500">pipeline</span>{' '}
                  <span className="font-mono text-gray-700">
                    {Object.entries(parsedFile.lens_metadata.pipeline)
                      .map(([k, v]) => `${k}=${String(v)}`)
                      .join(' ')}
                  </span>
                </div>
              )}
              <details className="pt-1">
                <summary className="cursor-pointer text-gray-500 hover:text-gray-700 select-none">
                  View raw JSON
                </summary>
                <pre className="mt-2 text-[11px] leading-4 overflow-auto bg-white border border-gray-200 rounded p-2 text-gray-700">
                  {JSON.stringify(parsedFile.lens_metadata, null, 2)}
                </pre>
              </details>
            </div>
          </div>
        )}
      </div>

      {/* Metrics */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Metrics</h3>
        <div className="space-y-2">
          {Object.keys(METRIC_LABELS).map(m => {
            const available = parsedFile.available_metrics.includes(m)
            const checked = selectedMetrics.includes(m)
            return (
              <label key={m} className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer
                ${!available ? 'opacity-40 cursor-not-allowed bg-gray-50 border-gray-100' :
                  checked ? 'border-blue-200 bg-blue-50' : 'border-gray-200 hover:border-gray-300'}`}>
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={checked}
                  disabled={!available}
                  onChange={() => available && toggleMetric(m)}
                />
                <div>
                  <p className="text-sm font-medium text-gray-800">{METRIC_LABELS[m]}</p>
                  <p className="text-xs text-gray-500">{METRIC_DESC[m]}</p>
                </div>
              </label>
            )
          })}
        </div>
      </div>

      {/* LLM config */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">LLM (judge)</h3>

        <div className="flex gap-2 mb-4">
          {['ollama', 'openai'].map(p => (
            <button key={p} onClick={() => setProvider(p)}
              className={`px-4 py-1.5 rounded-full text-sm font-medium border transition-colors
                ${provider === p ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-300 text-gray-700 hover:border-gray-400'}`}>
              {p === 'ollama' ? 'Ollama (on-prem)' : 'OpenAI'}
            </button>
          ))}
        </div>

        {provider === 'ollama' ? (
          <div className="space-y-3">
            <Field label="Base URL" value={ollamaUrl} onChange={setOllamaUrl} placeholder="http://localhost:11434" />
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Model</label>
              {ollamaModelsStatus.loading ? (
                <div className="text-sm text-gray-500 border border-gray-200 rounded-lg px-3 py-2 bg-gray-50">
                  Loading models...
                </div>
              ) : ollamaModels.length ? (
                <select
                  value={ollamaModels.includes(ollamaModel) ? ollamaModel : '__custom__'}
                  onChange={e => {
                    const v = e.target.value
                    if (v === '__custom__') return
                    setOllamaModel(v)
                  }}
                  className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  {ollamaModels.map(m => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                  <option value="__custom__">Custom…</option>
                </select>
              ) : (
                <Field label="Model" value={ollamaModel} onChange={setOllamaModel} placeholder="llama3.2" />
              )}
              {ollamaModelsStatus.error && (
                <div className="mt-1 text-xs text-amber-700">Couldn’t load models: {ollamaModelsStatus.error}</div>
              )}
              {!ollamaModelsStatus.loading && ollamaModels.length && !ollamaModels.includes(ollamaModel) && (
                <div className="mt-2">
                  <Field label="Custom model" value={ollamaModel} onChange={setOllamaModel} placeholder="llama3.2" />
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <Field label="API Key" value={openaiKey} onChange={setOpenaiKey} placeholder="sk-..." type="password" />
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Model</label>
              {openaiModelsStatus.loading ? (
                <div className="text-sm text-gray-500 border border-gray-200 rounded-lg px-3 py-2 bg-gray-50">
                  Loading models...
                </div>
              ) : openaiModels.length ? (
                <select
                  value={openaiModels.includes(openaiModel) ? openaiModel : '__custom__'}
                  onChange={e => {
                    const v = e.target.value
                    if (v === '__custom__') return
                    setOpenaiModel(v)
                  }}
                  className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  {openaiModels.map(m => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                  <option value="__custom__">Custom…</option>
                </select>
              ) : (
                <Field label="Model" value={openaiModel} onChange={setOpenaiModel} placeholder="gpt-4o-mini" />
              )}
              {openaiModelsStatus.error && (
                <div className="mt-1 text-xs text-amber-700">Couldn’t load models: {openaiModelsStatus.error}</div>
              )}
              {!openaiModelsStatus.loading && openaiModels.length && !openaiModels.includes(openaiModel) && (
                <div className="mt-2">
                  <Field label="Custom model" value={openaiModel} onChange={setOpenaiModel} placeholder="gpt-4o-mini" />
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Progress / error */}
      {showRunBanner && (
        <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-900">
          <p className="font-medium">Evaluation running in the background</p>
          <p className="text-blue-800/90 mt-1">
            Progress: {activeRun?.meta?.progress?.done ?? 0}
            {activeRun?.meta?.progress?.total != null
              ? ` / ${activeRun.meta.progress.total}`
              : ''}
            {' · '}
            Open <span className="font-medium">History</span> anytime for details.
          </p>
        </div>
      )}
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
      )}

      <div className="flex gap-3">
        <button onClick={onBack} disabled={starting}
          className="px-4 py-2 text-sm border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50">
          Back
        </button>
        <button onClick={handleRun} disabled={starting || !selectedMetrics.length}
          data-testid="run-evaluation"
          className="px-6 py-2 text-sm bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50">
          {starting ? 'Starting...' : 'Run Evaluation'}
        </button>
      </div>
    </div>
  )
}

function Field({ label, value, onChange, placeholder, type = 'text' }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    </div>
  )
}
