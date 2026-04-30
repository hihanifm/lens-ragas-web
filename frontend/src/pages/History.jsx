import { useEffect, useMemo, useState } from 'react'
import { cancelEvaluationJob } from '../api/client'
import { clearHistory, deleteRunFromHistory, loadHistory } from '../utils/history'

const METRIC_LABELS = {
  faithfulness: 'Faithfulness',
  answer_relevancy: 'Answer Relevancy',
  context_precision: 'Context Precision',
  context_recall: 'Context Recall',
}

export default function History({ onOpenRun, onBack, onDeleteRun }) {
  const [runs, setRuns] = useState([])

  useEffect(() => {
    setRuns(loadHistory())
    const id = setInterval(() => setRuns(loadHistory()), 1000)
    return () => clearInterval(id)
  }, [])

  const hasRuns = runs.length > 0
  const sortedRuns = useMemo(() => {
    return [...runs].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
  }, [runs])

  function handleOpen(run) {
    onOpenRun(run)
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

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">History</h2>
            <p className="text-sm text-gray-500 mt-1">
              Saved locally in this browser (last 50 runs).
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={onBack}
              className="px-4 py-2 text-sm font-medium bg-white border border-gray-300 rounded-lg text-gray-800 shadow-sm hover:bg-gray-50 hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
            >
              Back
            </button>
            <button
              onClick={handleClearAll}
              disabled={!hasRuns}
              className="px-4 py-2 text-sm font-medium bg-amber-50 border border-amber-300 rounded-lg text-amber-800 shadow-sm hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 disabled:opacity-50"
            >
              Clear
            </button>
          </div>
        </div>
      </div>

      {!hasRuns ? (
        <div className="bg-white rounded-xl border border-gray-200 p-8 text-sm text-gray-600">
          No saved runs yet. Run an evaluation to see it here.
        </div>
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
                {sortedRuns.map(run => {
                  const createdAt = run.createdAt ? new Date(run.createdAt) : null
                  const metrics = run?.results?.metrics || run?.meta?.metrics || []
                  const total = run?.results?.total ?? run?.meta?.total
                  const status = run?.meta?.status || 'complete'
                  const progress = run?.meta?.progress
                  const provider = run?.meta?.llm_provider || run?.meta?.provider
                  const model = run?.meta?.ollama_model || run?.meta?.openai_model || run?.meta?.model
                  return (
                    <tr key={run.id} className="border-b border-gray-100 hover:bg-gray-50">
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
                            onClick={() => handleOpen(run)}
                            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700"
                          >
                            Open
                          </button>
                          <button
                            onClick={() => void handleDelete(run.id)}
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

