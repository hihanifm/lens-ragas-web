import { useEffect, useState } from 'react'
import { loadHistory } from '../utils/history'

const METRIC_LABELS = {
  faithfulness: 'Faithfulness',
  answer_relevancy: 'Answer Relevancy',
  context_precision: 'Context Precision',
  context_recall: 'Context Recall',
}

export default function Results({ results, onReset }) {
  const [current, setCurrent] = useState(results)

  useEffect(() => {
    setCurrent(results)
  }, [results])

  useEffect(() => {
    const runId = current?.meta?.id
    if (!runId) return
    const id = setInterval(() => {
      const found = loadHistory().find(r => r.id === runId)
      if (found?.results) setCurrent(found.results)
    }, 1000)
    return () => clearInterval(id)
  }, [current?.meta?.id])

  const { rows, aggregate, metrics, meta, total: resultsTotal } = current

  const status = meta?.status
  const progress = meta?.progress
  const expectedTotal =
    meta?.total != null
      ? meta.total
      : resultsTotal != null
        ? resultsTotal
        : progress?.total != null
          ? progress.total
          : null
  const isFinal = status === 'complete' || status === 'error' || status === 'cancelled' || status === 'interrupted'
  const isRunning =
    status === 'running' ||
    (!isFinal && expectedTotal != null && rows.length < expectedTotal)

  function escapeCsvField(value) {
    return `"${String(value ?? '').replace(/"/g, '""')}"`
  }

  function exportCsv() {
    const header = ['question', ...metrics, 'ground_truth', 'contexts', 'answer', 'lens_metadata'].join(',')
    const lines = rows.map(r => {
      const ctxJson = JSON.stringify(Array.isArray(r.contexts) ? r.contexts : [])
      return [
        escapeCsvField(r.question),
        ...metrics.map(m => r.scores[m] ?? ''),
        escapeCsvField(r.ground_truth),
        escapeCsvField(ctxJson),
        escapeCsvField(r.answer),
        '',
      ].join(',')
    })
    let metaJson = ''
    if (meta?.lens_metadata) {
      try {
        metaJson = JSON.stringify(meta.lens_metadata).replace(/"/g, '""')
      } catch {
        metaJson = ''
      }
    }

    const aggLine = [
      '"AGGREGATE"',
      ...metrics.map(m => aggregate[m] ?? ''),
      '""',
      '""',
      '""',
      metaJson ? `"${metaJson}"` : '',
    ].join(',')

    const csv = [header, ...lines, aggLine].join('\n')

    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = buildExportFilename(meta?.input_filename)
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6">
      {isRunning && (
        <div
          className="flex items-start gap-3 p-4 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-900"
          data-testid="results-running-banner"
        >
          <span
            className="mt-0.5 inline-block h-2 w-2 rounded-full bg-blue-500 animate-pulse shrink-0"
            aria-hidden
          />
          <div>
            <p className="font-medium">Evaluation in progress</p>
            <p className="text-blue-800/90 mt-0.5">
              Scoring rows as they complete: {rows.length}
              {expectedTotal != null ? ` / ${expectedTotal}` : ''}
            </p>
            <p className="text-xs text-blue-700/80 mt-1">
              Final aggregates update when all rows are done. You can leave this page; progress is saved in History.
            </p>
          </div>
        </div>
      )}

      {/* Aggregate summary */}
      <div className="bg-white rounded-xl border border-gray-200 p-5" data-testid="results-aggregate">
        <h2 className="text-sm font-semibold text-gray-900 mb-4">
          Aggregate scores
          {isRunning ? ` (partial — ${rows.length} of ${expectedTotal ?? '?'} rows)` : ` (${rows.length} rows)`}
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {metrics.map(m => (
            <div key={m} className="bg-gray-50 rounded-lg px-4 py-3 text-center">
              <p className="text-xs text-gray-500 mb-1">{METRIC_LABELS[m] || m}</p>
              <p className={`text-2xl font-semibold ${scoreColor(aggregate[m])}`}>
                {aggregate[m] != null ? aggregate[m].toFixed(3) : '—'}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* LENS export metadata */}
      {meta?.lens_metadata && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <details>
            <summary className="text-sm font-semibold text-gray-900 cursor-pointer select-none hover:text-gray-700">
              Export metadata
            </summary>
            <div className="mt-3 text-xs text-gray-600 space-y-1">
              {meta.lens_metadata.exported_at && (
                <div>
                  <span className="text-gray-500">exported_at</span>{' '}
                  <span className="font-mono text-gray-700">{meta.lens_metadata.exported_at}</span>
                </div>
              )}
              {meta.lens_metadata.k != null && (
                <div>
                  <span className="text-gray-500">k</span>{' '}
                  <span className="font-mono text-gray-700">{String(meta.lens_metadata.k)}</span>
                </div>
              )}
              {meta.lens_metadata.pipeline && typeof meta.lens_metadata.pipeline === 'object' && (
                <div>
                  <span className="text-gray-500">pipeline</span>{' '}
                  <span className="font-mono text-gray-700">
                    {Object.entries(meta.lens_metadata.pipeline)
                      .map(([k, v]) => `${k}=${String(v)}`)
                      .join(' ')}
                  </span>
                </div>
              )}
              <details className="pt-1">
                <summary className="cursor-pointer text-gray-500 hover:text-gray-700 select-none">
                  View raw JSON
                </summary>
                <pre className="mt-2 text-[11px] leading-4 overflow-auto bg-gray-50 border border-gray-200 rounded p-2 text-gray-700">
                  {JSON.stringify(meta.lens_metadata, null, 2)}
                </pre>
              </details>
            </div>
          </details>
        </div>
      )}

      {/* Per-row table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-max min-w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-3 py-3 font-medium text-gray-600 w-10">#</th>
                <th className="text-left px-3 py-3 font-medium text-gray-600 min-w-[200px]">Question</th>
                <th className="text-left px-3 py-3 font-medium text-gray-600 min-w-[180px]">Ground truth</th>
                <th className="text-left px-3 py-3 font-medium text-gray-600 min-w-[220px]">
                  Retrieved contexts
                </th>
                <th className="text-left px-3 py-3 font-medium text-gray-600 min-w-[180px]">Response</th>
                {metrics.map(m => (
                  <th key={m} className="text-center px-3 py-3 font-medium text-gray-600 whitespace-nowrap w-28">
                    {METRIC_LABELS[m] || m}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-b border-gray-100 hover:bg-gray-50 align-top">
                  <td className="px-3 py-3 text-gray-400 tabular-nums">{i + 1}</td>
                  <td className="px-3 py-3 align-top min-w-[200px] max-w-md">
                    <div className="text-xs text-gray-800 whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
                      {row.question || '—'}
                    </div>
                  </td>
                  <td className="px-3 py-3 align-top min-w-[180px] max-w-md">
                    <div className="text-xs text-gray-700 whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
                      {cellOrDash(row.ground_truth)}
                    </div>
                  </td>
                  <td className="px-3 py-3 align-top min-w-[220px] max-w-lg">
                    <div className="text-xs text-gray-700 whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
                      {formatContextsCell(row.contexts)}
                    </div>
                  </td>
                  <td className="px-3 py-3 align-top min-w-[180px] max-w-md">
                    <div className="text-xs text-gray-700 whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
                      {cellOrDash(row.answer)}
                    </div>
                  </td>
                  {metrics.map(m => (
                    <td
                      key={m}
                      className={`px-3 py-3 text-center text-xs font-medium align-middle ${scoreColor(row.scores?.[m])}`}
                    >
                      {row.scores?.[m] != null ? row.scores[m].toFixed(3) : '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex gap-3">
        <button onClick={onReset}
          className="px-4 py-2 text-sm border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50">
          Start Over
        </button>
        <button onClick={exportCsv}
          disabled={isRunning}
          title={isRunning ? 'Wait until the run finishes for a complete export' : undefined}
          className="px-6 py-2 text-sm bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed">
          Export CSV
        </button>
      </div>
    </div>
  )
}

function buildExportFilename(inputFilename) {
  const fallback = 'ragas_scores.csv'
  if (!inputFilename || typeof inputFilename !== 'string') return fallback

  const base = inputFilename.replace(/\.[^/.]+$/, '')
  const safeBase = base
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')

  if (!safeBase) return fallback
  return `${safeBase}_ragas_scores.csv`
}

function scoreColor(val) {
  if (val == null) return 'text-gray-400'
  if (val >= 0.8) return 'text-green-600'
  if (val >= 0.5) return 'text-amber-600'
  return 'text-red-600'
}

function cellOrDash(v) {
  if (v == null || String(v).trim() === '') return '—'
  return String(v)
}

function formatContextsCell(ctx) {
  if (ctx == null) return '—'
  if (!Array.isArray(ctx) || ctx.length === 0) return '—'
  return ctx.map((c, i) => `(${i + 1}) ${c}`).join('\n\n')
}
