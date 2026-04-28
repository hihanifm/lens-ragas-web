import { useState, useRef, useEffect } from 'react'
import { streamEvaluation, fetchConfig } from '../api/client'

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

export default function Configure({ parsedFile, onResults, onBack, onRunStateChange }) {
  const [provider, setProvider] = useState('ollama')
  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434')

  const [ollamaModel, setOllamaModel] = useState('llama3.2')
  const [openaiKey, setOpenaiKey] = useState('')
  const [openaiModel, setOpenaiModel] = useState('gpt-4o-mini')
  const [selectedMetrics, setSelectedMetrics] = useState(parsedFile.available_metrics)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(null) // { done, total }
  const [error, setError] = useState(null)
  const cancelRef = useRef(null)

  useEffect(() => {
    fetchConfig().then(cfg => {
      setProvider(cfg.llm_provider || 'ollama')
      if (cfg.ollama_base_url) setOllamaUrl(cfg.ollama_base_url)
      if (cfg.ollama_model) setOllamaModel(cfg.ollama_model)
      if (cfg.openai_api_key) setOpenaiKey(cfg.openai_api_key)
      if (cfg.openai_model) setOpenaiModel(cfg.openai_model)
    }).catch(() => {})
  }, [])

  // Cancel stream and notify parent if this component is unmounted mid-run
  useEffect(() => {
    return () => {
      cancelRef.current?.()
      onRunStateChange?.(false, null)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function toggleMetric(m) {
    setSelectedMetrics(prev =>
      prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m]
    )
  }

  function handleRun() {
    if (!selectedMetrics.length) return
    setError(null)
    setRunning(true)
    const initialProgress = { done: 0, total: null }
    setProgress(initialProgress)
    onRunStateChange?.(true, initialProgress)

    const rows = []

    const req = {
      file_id: parsedFile.file_id,
      metrics: selectedMetrics,
      llm_provider: provider,
      ollama_base_url: ollamaUrl,
      ollama_model: ollamaModel,
      openai_api_key: openaiKey || undefined,
      openai_model: openaiModel,
    }

    cancelRef.current = streamEvaluation(req, {
      onStart: ({ total }) => {
        const p = { done: 0, total }
        setProgress(p)
        onRunStateChange?.(true, p)
      },
      onRow: (row) => {
        rows.push(row)
        setProgress(p => {
          const next = { ...p, done: rows.length }
          onRunStateChange?.(true, next)
          return next
        })
      },
      onComplete: ({ aggregate, total }) => {
        setRunning(false)
        onRunStateChange?.(false, null)
        onResults(
          { rows, aggregate, metrics: selectedMetrics, total },
          {
            provider,
            llm_provider: provider,
            ollama_base_url: provider === 'ollama' ? ollamaUrl : undefined,
            ollama_model: provider === 'ollama' ? ollamaModel : undefined,
            openai_model: provider === 'openai' ? openaiModel : undefined,
            file_id: parsedFile?.file_id,
            row_count: parsedFile?.row_count,
            format: parsedFile?.format,
            input_filename: parsedFile?.input_filename,
            lens_metadata: parsedFile?.lens_metadata,
          }
        )
      },
      onError: (msg) => {
        setRunning(false)
        onRunStateChange?.(false, null)
        setError(msg)
      },
    })
  }

  function handleCancel() {
    cancelRef.current?.()
    setRunning(false)
    setProgress(null)
    onRunStateChange?.(false, null)
  }

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
            <Field label="Model" value={ollamaModel} onChange={setOllamaModel} placeholder="llama3.2" />
          </div>
        ) : (
          <div className="space-y-3">
            <Field label="API Key" value={openaiKey} onChange={setOpenaiKey} placeholder="sk-..." type="password" />
            <Field label="Model" value={openaiModel} onChange={setOpenaiModel} placeholder="gpt-4o-mini" />
          </div>
        )}
      </div>

      {/* Progress / error */}
      {running && progress && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm text-gray-700 font-medium">
              Evaluating... {progress.done}{progress.total ? ` / ${progress.total}` : ''}
            </p>
            <button onClick={handleCancel} className="text-sm text-red-500 hover:underline">Cancel</button>
          </div>
          {progress.total && (
            <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-2 bg-blue-500 rounded-full transition-all"
                style={{ width: `${(progress.done / progress.total) * 100}%` }}
              />
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
      )}

      <div className="flex gap-3">
        <button onClick={onBack} disabled={running}
          className="px-4 py-2 text-sm border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50">
          Back
        </button>
        <button onClick={handleRun} disabled={running || !selectedMetrics.length}
          data-testid="run-evaluation"
          className="px-6 py-2 text-sm bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50">
          {running ? 'Running...' : 'Run Evaluation'}
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
