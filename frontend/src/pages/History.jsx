import { useEffect, useMemo, useState } from 'react'
import { clearHistory, deleteRunFromHistory, loadHistory } from '../utils/history'

const METRIC_LABELS = {
  faithfulness: 'Faithfulness',
  answer_relevancy: 'Answer Relevancy',
  context_precision: 'Context Precision',
  context_recall: 'Context Recall',
}

export default function History({ onOpenRun, onBack }) {
  const [runs, setRuns] = useState([])

  useEffect(() => {
    setRuns(loadHistory())
  }, [])

  const hasRuns = runs.length > 0
  const sortedRuns = useMemo(() => {
    return [...runs].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
  }, [runs])

  function handleOpen(run) {
    onOpenRun(run)
  }

  function handleDelete(runId) {
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
              Saved locally in this browser (last 20 runs).
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
                  const provider = run?.meta?.llm_provider || run?.meta?.provider
                  const model = run?.meta?.ollama_model || run?.meta?.openai_model || run?.meta?.model
                  return (
                    <tr key={run.id} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="px-4 py-3 text-gray-700 whitespace-nowrap">
                        {createdAt ? createdAt.toLocaleString() : '—'}
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
                            onClick={() => handleDelete(run.id)}
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

