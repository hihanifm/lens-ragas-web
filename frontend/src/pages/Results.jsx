import { useEffect, useState } from 'react'
import { loadHistory } from '../utils/history'
import { downloadScoredXlsx } from '../api/client'

const METRIC_LABELS = {
  faithfulness: 'Faithfulness',
  answer_relevancy: 'Answer Relevancy',
  context_precision: 'Context Precision',
  context_recall: 'Context Recall',
}

export default function Results({ results, onReset, onCancelRunningJob }) {
  const [current, setCurrent] = useState(results)
  const [expanded, setExpanded] = useState(() => new Set())
  const [activePane, setActivePane] = useState('results') // results | stats

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
  const streamDisconnected = Boolean(meta?.stream_disconnected)
  const stats = meta?.stats || current?.stats || null
  const elapsedMs = stats?.elapsed_ms
  const llmCalls = stats?.llm_calls
  const promptTokens = stats?.prompt_tokens
  const completionTokens = stats?.completion_tokens
  const totalTokens = stats?.total_tokens
  const costUsd = stats?.cost_usd

  const jobId = meta?.job_id
  const isXlsx = typeof meta?.input_filename === 'string' && meta.input_filename.toLowerCase().endsWith('.xlsx')

  function getGroundTruth(row) {
    return row?.ground_truth ?? row?.reference ?? null
  }

  function getAnswer(row) {
    return row?.answer ?? row?.response ?? null
  }

  function getContexts(row) {
    const v = row?.contexts ?? row?.retrieved_contexts ?? row?.retrievedContexts ?? null
    return Array.isArray(v) ? v : v == null ? null : [String(v)]
  }

  function escapeCsvField(value) {
    return `"${String(value ?? '').replace(/"/g, '""')}"`
  }

  function exportCsv() {
    const header = ['question', ...metrics, 'ground_truth', 'contexts', 'answer', 'lens_metadata'].join(',')
    const lines = rows.map(r => {
      const ctxJson = JSON.stringify(getContexts(r) || [])
      return [
        escapeCsvField(r.question),
        ...metrics.map(m => r.scores[m] ?? ''),
        escapeCsvField(getGroundTruth(r)),
        escapeCsvField(ctxJson),
        escapeCsvField(getAnswer(r)),
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

  async function exportScoredXlsx() {
    if (!jobId) return
    const { blob, filename } = await downloadScoredXlsx(jobId)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
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
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <p className="font-medium">Evaluation in progress</p>
              {jobId && onCancelRunningJob ? (
                <button
                  type="button"
                  onClick={() => void onCancelRunningJob(jobId)}
                  className="shrink-0 px-3 py-1.5 text-xs font-medium bg-white border border-blue-300 rounded-lg text-blue-900 hover:bg-blue-100"
                >
                  Cancel run
                </button>
              ) : null}
            </div>
            <p className="text-blue-800/90 mt-0.5">
              Scoring rows as they complete: {rows.length}
              {expectedTotal != null ? ` / ${expectedTotal}` : ''}
            </p>
            <p className="text-xs text-blue-700/80 mt-1">
              Final aggregates update when all rows are done. You can leave this page; progress is saved in History.
            </p>
            {streamDisconnected && (
              <p className="text-xs text-amber-800 mt-2">
                Live streaming disconnected. Results will keep updating from History while the job runs.
              </p>
            )}
          </div>
        </div>
      )}

      {status === 'error' && meta?.error && (
        <div
          className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800"
          data-testid="results-error-banner"
        >
          <p className="font-medium text-red-900">Evaluation failed</p>
          <p className="mt-1 whitespace-pre-wrap break-words">{String(meta.error)}</p>
        </div>
      )}

      {/* Panes */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setActivePane('results')}
          className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
            activePane === 'results'
              ? 'bg-gray-900 text-white border-gray-900'
              : 'bg-white text-gray-700 border-gray-300 hover:border-gray-400'
          }`}
        >
          Results
        </button>
        <button
          type="button"
          onClick={() => setActivePane('stats')}
          className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
            activePane === 'stats'
              ? 'bg-gray-900 text-white border-gray-900'
              : 'bg-white text-gray-700 border-gray-300 hover:border-gray-400'
          }`}
        >
          Stats
        </button>
      </div>

      {activePane === 'stats' && (
        <div className="bg-white rounded-xl border border-gray-200 p-5" data-testid="results-stats-pane">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Stats</h2>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Status" value={String(status || '—')} />
            <StatCard
              label="Rows"
              value={
                expectedTotal != null ? `${rows.length} / ${expectedTotal}` : rows?.length != null ? String(rows.length) : '—'
              }
            />
            <StatCard label="Latency" value={elapsedMs != null ? `${(elapsedMs / 1000).toFixed(1)}s` : '—'} />
            <StatCard label="LLM calls" value={llmCalls != null ? String(llmCalls) : '—'} />
          </div>

          <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Prompt tokens" value={promptTokens != null ? String(promptTokens) : '—'} />
            <StatCard label="Completion tokens" value={completionTokens != null ? String(completionTokens) : '—'} />
            <StatCard label="Total tokens" value={totalTokens != null ? String(totalTokens) : '—'} />
            <StatCard
              label="Cost"
              value={costUsd != null ? `$${Number(costUsd).toFixed(4)}` : '—'}
            />
          </div>

          <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="border border-gray-200 rounded-lg p-4">
              <p className="text-xs font-medium text-gray-500 mb-2">Models / endpoint</p>
              <div className="text-sm text-gray-800 space-y-1">
                <KeyVal k="provider" v={meta?.llm_provider || meta?.provider} />
                <KeyVal k="ollama_model" v={meta?.ollama_model} />
                <KeyVal k="openai_model" v={meta?.openai_model} />
                <KeyVal k="ollama_base_url" v={meta?.ollama_base_url} />
                <KeyVal k="project" v={meta?.project} />
              </div>
            </div>
            <div className="border border-gray-200 rounded-lg p-4">
              <p className="text-xs font-medium text-gray-500 mb-2">Reliability</p>
              <div className="text-sm text-gray-800 space-y-1">
                <KeyVal k="stream_disconnected" v={streamDisconnected ? 'true' : 'false'} />
                <KeyVal k="error" v={meta?.error} />
                <KeyVal k="job_id" v={meta?.job_id} />
                <KeyVal k="input_filename" v={meta?.input_filename} />
              </div>
            </div>
          </div>

          <div className="mt-4 text-xs text-gray-500">
            Stats are persisted on the server per run (when available) and may appear a moment after completion.
          </div>
        </div>
      )}

      {activePane === 'results' && (
        <>
      {/* Aggregate summary */}
      <div className="bg-white rounded-xl border border-gray-200 p-5" data-testid="results-aggregate">
        <h2 className="text-sm font-semibold text-gray-900 mb-4">
          Aggregate scores
          {isRunning ? ` (partial — ${rows.length} of ${expectedTotal ?? '?'} rows)` : ` (${rows.length} rows)`}
        </h2>
        {(elapsedMs != null || llmCalls != null || totalTokens != null || costUsd != null) && (
          <div className="text-xs text-gray-500 mb-3">
            {elapsedMs != null && <span className="mr-3">Latency: {(elapsedMs / 1000).toFixed(1)}s</span>}
            {llmCalls != null && <span className="mr-3">LLM calls: {llmCalls}</span>}
            {totalTokens != null && <span className="mr-3">Tokens: {totalTokens}</span>}
            {costUsd != null && <span className="mr-3">Cost: ${Number(costUsd).toFixed(4)}</span>}
          </div>
        )}
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
          <table className="min-w-[1200px] w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-3 py-3 font-medium text-gray-600 w-10">#</th>
                <th className="text-left px-3 py-3 font-medium text-gray-600 min-w-[180px] max-w-[320px]">Question</th>
                <th className="text-left px-3 py-3 font-medium text-gray-600 min-w-[160px] max-w-[280px]">Ground truth</th>
                <th className="text-left px-3 py-3 font-medium text-gray-600 min-w-[200px] max-w-[360px]">
                  Retrieved contexts
                </th>
                <th className="text-left px-3 py-3 font-medium text-gray-600 min-w-[180px] max-w-[320px]">Response</th>
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
                  <td className="px-3 py-3 align-top min-w-[180px] max-w-[320px]">
                    <ExpandableCell
                      value={row.question || '—'}
                      cellKey={`${row.index ?? i}:question`}
                      expanded={expanded}
                      setExpanded={setExpanded}
                      tone="dark"
                    />
                  </td>
                  <td className="px-3 py-3 align-top min-w-[160px] max-w-[280px]">
                    <ExpandableCell
                      value={cellOrDash(getGroundTruth(row))}
                      cellKey={`${row.index ?? i}:ground_truth`}
                      expanded={expanded}
                      setExpanded={setExpanded}
                    />
                  </td>
                  <td className="px-3 py-3 align-top min-w-[200px] max-w-[360px]">
                    <ExpandableCell
                      value={formatContextsCell(getContexts(row))}
                      cellKey={`${row.index ?? i}:contexts`}
                      expanded={expanded}
                      setExpanded={setExpanded}
                    />
                  </td>
                  <td className="px-3 py-3 align-top min-w-[180px] max-w-[320px]">
                    <ExpandableCell
                      value={cellOrDash(getAnswer(row))}
                      cellKey={`${row.index ?? i}:answer`}
                      expanded={expanded}
                      setExpanded={setExpanded}
                    />
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
        {isXlsx && jobId && (
          <button
            onClick={() => void exportScoredXlsx()}
            disabled={isRunning}
            title={isRunning ? 'Wait until the run finishes for a complete export' : undefined}
            className="px-6 py-2 text-sm bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Download scored Excel
          </button>
        )}
        <button onClick={exportCsv}
          disabled={isRunning}
          title={isRunning ? 'Wait until the run finishes for a complete export' : undefined}
          className="px-6 py-2 text-sm bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed">
          Export CSV
        </button>
      </div>
        </>
      )}
    </div>
  )
}

function StatCard({ label, value }) {
  return (
    <div className="bg-gray-50 rounded-lg px-4 py-3">
      <p className="text-[11px] uppercase tracking-wide text-gray-500">{label}</p>
      <p className="text-sm font-semibold text-gray-900 mt-1 tabular-nums">{value}</p>
    </div>
  )
}

function KeyVal({ k, v }) {
  if (v == null || String(v).trim() === '') return null
  return (
    <div className="flex items-start gap-2">
      <span className="text-gray-500 text-xs font-mono shrink-0">{k}</span>
      <span className="text-gray-800 text-xs font-mono break-all">{String(v)}</span>
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

function ExpandableCell({ value, cellKey, expanded, setExpanded, tone = 'normal' }) {
  const text = String(value ?? '')
  const isDash = text.trim() === '—'
  const isExpanded = expanded.has(cellKey)

  function toggle() {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(cellKey)) next.delete(cellKey)
      else next.add(cellKey)
      return next
    })
  }

  const textClass = tone === 'dark' ? 'text-gray-800' : 'text-gray-700'

  return (
    <div className={`text-xs ${textClass} whitespace-pre`}>
      <div
        style={
          isExpanded
            ? undefined
            : {
                display: '-webkit-box',
                WebkitBoxOrient: 'vertical',
                WebkitLineClamp: 6,
                overflow: 'hidden',
              }
        }
      >
        {text}
      </div>
      {!isDash && (
        <button
          type="button"
          onClick={toggle}
          className="mt-1 text-[11px] text-blue-600 hover:underline"
        >
          {isExpanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}
