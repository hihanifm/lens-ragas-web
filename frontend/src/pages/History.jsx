import { useEffect, useMemo, useState } from 'react'
import { cancelEvaluationJob, deleteServerRun, fetchEvaluationResult, fetchServerRuns } from '../api/client'
import { clearHistory, deleteRunFromHistory, loadHistory } from '../utils/history'

const METRIC_LABELS = {
  faithfulness: 'Faithfulness',
  answer_relevancy: 'Answer Relevancy',
  context_precision: 'Context Precision',
  context_recall: 'Context Recall',
}

export default function History({ onOpenRun, onBack, onDeleteRun }) {
  const [mode, setMode] = useState('local') // local | server
  const [runs, setRuns] = useState([])
  const [serverRuns, setServerRuns] = useState([])
  const [serverStatus, setServerStatus] = useState({ loading: false, error: null })

  useEffect(() => {
    setRuns(loadHistory())
    const id = setInterval(() => setRuns(loadHistory()), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (mode !== 'server') return
    let cancelled = false
    setServerStatus({ loading: true, error: null })
    const tick = async () => {
      try {
        const list = await fetchServerRuns({ limit: 200, offset: 0 })
        if (cancelled) return
        setServerRuns(Array.isArray(list) ? list : [])
        setServerStatus({ loading: false, error: null })
      } catch (e) {
        if (cancelled) return
        setServerRuns([])
        setServerStatus({ loading: false, error: e?.response?.data?.detail || e?.message || 'Failed to load runs' })
      }
    }
    void tick()
    const id = setInterval(() => void tick(), 2000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [mode])

  const localHasRuns = runs.length > 0
  const sortedLocalRuns = useMemo(() => {
    return [...runs].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
  }, [runs])

  const serverHasRuns = serverRuns.length > 0
  const sortedServerRuns = useMemo(() => {
    return [...serverRuns].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
  }, [serverRuns])

  function handleOpen(run) {
    onOpenRun(run)
  }

  async function handleOpenServer(run) {
    try {
      const snap = await fetchEvaluationResult(run.job_id)
      // Open Results using the same shape History uses (entry.results)
      onOpenRun({ id: run.job_id, results: snap })
    } catch {
      // ignore; user can retry
    }
  }

  async function handleDelete(runId) {
    const current = loadHistory()
    const entry = current.find(r => r.id === runId)
    const status = entry?.meta?.status
    const jobId = entry?.meta?.job_id

    if (status === 'running' && jobId) {
      try {
        await cancelEvaluationJob(jobId)
      } catch {
        // still remove from local history; backend may be unreachable
      }
    }
    onDeleteRun?.(entry)
    const next = deleteRunFromHistory(runId)
    setRuns(next)
  }

  function handleClearAll() {
    clearHistory()
    setRuns([])
  }

  async function handleDeleteServer(run) {
    const jobId = run?.job_id
    if (!jobId) return
    if (
      !window.confirm(
        'Delete this run from the server history? This affects all PCs using this server.',
      )
    ) {
      return
    }
    if (run.status === 'running') {
      try {
        await cancelEvaluationJob(jobId)
      } catch {
        // ignore
      }
    }
    try {
      await deleteServerRun(jobId)
      setServerRuns(prev => prev.filter(r => r.job_id !== jobId))
    } catch {
      // ignore
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">History</h2>
            <p className="text-sm text-gray-500 mt-1">Local runs are this PC only. Server runs are shared.</p>
            <div className="mt-3 inline-flex rounded-lg border border-gray-200 overflow-hidden">
              <button
                type="button"
                onClick={() => setMode('local')}
                className={`px-3 py-1.5 text-sm ${mode === 'local' ? 'bg-gray-900 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
              >
                Local
              </button>
              <button
                type="button"
                onClick={() => setMode('server')}
                className={`px-3 py-1.5 text-sm ${mode === 'server' ? 'bg-gray-900 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
              >
                Server
              </button>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={onBack}
              className="px-4 py-2 text-sm font-medium bg-white border border-gray-300 rounded-lg text-gray-800 shadow-sm hover:bg-gray-50 hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
            >
              Back
            </button>
            {mode === 'local' && (
              <button
                onClick={handleClearAll}
                disabled={!localHasRuns}
                className="px-4 py-2 text-sm font-medium bg-amber-50 border border-amber-300 rounded-lg text-amber-800 shadow-sm hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 disabled:opacity-50"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      </div>

      {mode === 'local' && !localHasRuns ? (
        <div className="bg-white rounded-xl border border-gray-200 p-8 text-sm text-gray-600">No local runs yet.</div>
      ) : mode === 'server' && serverStatus.loading ? (
        <div className="bg-white rounded-xl border border-gray-200 p-8 text-sm text-gray-600">Loading server runs…</div>
      ) : mode === 'server' && serverStatus.error ? (
        <div className="bg-white rounded-xl border border-red-200 p-8 text-sm text-red-700">{serverStatus.error}</div>
      ) : mode === 'server' && !serverHasRuns ? (
        <div className="bg-white rounded-xl border border-gray-200 p-8 text-sm text-gray-600">No server runs yet.</div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">When</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Rows</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Metrics</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">LLM</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(mode === 'local' ? sortedLocalRuns : sortedServerRuns).map(run => {
                  const isServer = mode === 'server'
                  const createdAt = isServer
                    ? (run.created_at ? new Date(run.created_at) : null)
                    : (run.createdAt ? new Date(run.createdAt) : null)
                  const metrics = isServer ? (run.metrics || []) : (run?.results?.metrics || run?.meta?.metrics || [])
                  const total = isServer ? run?.total : (run?.results?.total ?? run?.meta?.total)
                  const status = isServer ? (run?.status || 'complete') : (run?.meta?.status || 'complete')
                  const progress = isServer ? run?.progress : run?.meta?.progress
                  const provider = isServer ? run?.provider : (run?.meta?.llm_provider || run?.meta?.provider)
                  const model = isServer ? run?.model : (run?.meta?.ollama_model || run?.meta?.openai_model || run?.meta?.model)
                  return (
                    <tr key={isServer ? run.job_id : run.id} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="px-4 py-3 text-gray-700 whitespace-nowrap">
                        {createdAt ? createdAt.toLocaleString() : '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-700 whitespace-nowrap">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs border
                          ${status === 'running' ? 'bg-blue-50 text-blue-700 border-blue-200'
                            : status === 'complete' ? 'bg-green-50 text-green-700 border-green-200'
                              : status === 'error' ? 'bg-red-50 text-red-700 border-red-200'
                                : status === 'cancelled' ? 'bg-gray-50 text-gray-700 border-gray-200'
                                  : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
                          {status}
                          {status === 'running' && progress && (
                            <span className="ml-2 tabular-nums text-[11px] text-blue-600">
                              {progress.done}{progress.total ? `/${progress.total}` : ''}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-700">
                        {total != null ? total : (run?.results?.rows?.length ?? '—')}
                      </td>
                      <td className="px-4 py-3 text-gray-700">
                        {Array.isArray(metrics) && metrics.length
                          ? metrics.map(m => METRIC_LABELS[m] || m).join(', ')
                          : '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-700">
                        {provider ? (model ? `${provider} · ${model}` : provider) : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-2">
                          <button
                            onClick={() => (isServer ? void handleOpenServer(run) : handleOpen(run))}
                            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700"
                          >
                            Open
                          </button>
                          <button
                            onClick={() => {
                              if (isServer) return void handleDeleteServer(run)
                              if (!window.confirm('Remove this run from history? This only affects saved entries in this browser.')) return
                              void handleDelete(run.id)
                            }}
                            className="px-3 py-1.5 text-sm font-medium bg-red-50 border border-red-300 rounded-lg text-red-700 shadow-sm hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

