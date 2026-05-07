import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Upload from './pages/Upload'
import Configure from './pages/Configure'
import Results from './pages/Results'
import History from './pages/History'
import { loadHistory, saveRunToHistory } from './utils/history'
import { uuid } from './utils/uuid'
import Footer from './components/Footer'
import { cancelEvaluationJob, fetchEvaluationResult, startEvaluationJob, streamEvaluationJob } from './api/client'

/** Insert or replace by SSE `row.index` so stream replay cannot duplicate rows. */
function upsertEvalRow(rows, row) {
  const idx = row?.index
  if (typeof idx !== 'number') {
    rows.push(row)
    return
  }
  const pos = rows.findIndex(r => r && r.index === idx)
  if (pos >= 0) rows[pos] = row
  else rows.push(row)
  rows.sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0))
}

export default function App() {
  const [step, setStep] = useState('upload') // upload | configure | results | history
  const [parsedFile, setParsedFile] = useState(null)
  const [evalResults, setEvalResults] = useState(null)
  const cancelByRunIdRef = useRef(new Map()) // runId -> cancelFn
  const attachedJobIdsRef = useRef(new Set())
  const [runningCount, setRunningCount] = useState(0)

  const runningSummary = useMemo(() => {
    if (runningCount <= 0) return null
    return `${runningCount} running`
  }, [runningCount])

  const attachRunningJob = useCallback(({ runId, jobId, run, skipRunningCountBump }) => {
    if (!jobId || !runId || !run?.meta) return
    if (attachedJobIdsRef.current.has(jobId)) return

    attachedJobIdsRef.current.add(jobId)
    if (!skipRunningCountBump) {
      setRunningCount(c => c + 1)
    }

    const runMeta = run.meta
    let pollId = null
    let finalized = false

    const finalizeOnce = () => {
      if (finalized) return
      finalized = true
      attachedJobIdsRef.current.delete(jobId)
      setRunningCount(c => Math.max(0, c - 1))
      cancelByRunIdRef.current.delete(runId)
      if (pollId) {
        clearInterval(pollId)
        pollId = null
      }
    }

    const pollResultUntilDone = () => {
      if (pollId) return
      const tick = async () => {
        try {
          const snap = await fetchEvaluationResult(jobId)
          runMeta.status = snap.status || runMeta.status
          runMeta.progress = snap.progress || runMeta.progress
          runMeta.error = snap.error || runMeta.error
          runMeta.stats = snap.stats || runMeta.stats
          runMeta.metrics = snap.metrics || runMeta.metrics
          runMeta.total = snap.total ?? runMeta.total

          run.results.rows = snap.rows || run.results.rows
          run.results.aggregate = snap.aggregate || run.results.aggregate
          run.results.metrics = runMeta.metrics || run.results.metrics
          run.results.total = runMeta.total ?? run.results.total

          saveRunToHistory({ meta: runMeta, results: { ...run.results, meta: runMeta } })

          if (snap.status && snap.status !== 'running') {
            finalizeOnce()
          }
        } catch {
          // If polling fails intermittently, keep the run in "running" state and try again.
        }
      }
      void tick()
      pollId = setInterval(() => void tick(), 1500)
    }

    const cancelStream = streamEvaluationJob(jobId, {
      onStart: ({ total, metrics }) => {
        run.results.rows = []
        runMeta.progress = { done: 0, total }
        runMeta.metrics = metrics || runMeta.metrics
        runMeta.total = total
        runMeta.status = 'running'
        runMeta.stream_disconnected = false
        saveRunToHistory({
          meta: runMeta,
          results: { ...run.results, metrics: runMeta.metrics, total, meta: runMeta },
        })
      },
      onRow: row => {
        upsertEvalRow(run.results.rows, row)
        runMeta.progress = { ...runMeta.progress, done: run.results.rows.length }
        saveRunToHistory({
          meta: runMeta,
          results: { ...run.results, total: runMeta.total ?? run.results.rows.length, meta: runMeta },
        })
      },
      onComplete: ({ aggregate, total }) => {
        run.results.aggregate = aggregate || {}
        run.results.total = total ?? run.results.rows.length
        runMeta.total = run.results.total
        runMeta.status = 'complete'
        runMeta.progress = { done: run.results.total, total: run.results.total }
        saveRunToHistory({ meta: runMeta, results: { ...run.results, meta: runMeta } })
        fetchEvaluationResult(jobId)
          .then(snap => {
            if (snap?.stats) {
              runMeta.stats = snap.stats
              saveRunToHistory({ meta: runMeta, results: { ...run.results, meta: runMeta } })
            }
          })
          .catch(() => {})
        finalizeOnce()
      },
      onError: msg => {
        if (msg === 'cancelled') {
          runMeta.status = 'cancelled'
          runMeta.error = msg
          saveRunToHistory({ meta: runMeta, results: { ...run.results, meta: runMeta } })
          finalizeOnce()
          return
        }

        runMeta.stream_disconnected = true
        runMeta.error =
          'Connection lost while streaming results. The evaluation may still be running — progress will continue updating via History.'
        saveRunToHistory({ meta: runMeta, results: { ...run.results, meta: runMeta } })
        pollResultUntilDone()
      },
    })

    cancelByRunIdRef.current.set(runId, async () => {
      try {
        await cancelEvaluationJob(jobId)
      } catch {
        // ignore
      }
      cancelStream?.()
      if (pollId) {
        clearInterval(pollId)
        pollId = null
      }
    })
  }, [])

  function handleParsed(data) {
    setParsedFile(data)
    setStep('configure')
  }

  function handleLoadScores(results) {
    setParsedFile(null)
    setEvalResults(results)
    setStep('results')
  }

  async function startRun(req, meta = {}) {
    const runId = uuid()
    const runMeta = {
      id: runId,
      createdAt: new Date().toISOString(),
      status: 'running',
      progress: { done: 0, total: null },
      ...meta,
    }

    const run = {
      meta: runMeta,
      results: {
        rows: [],
        aggregate: {},
        metrics: meta?.metrics || req?.metrics || [],
        total: null,
        meta: runMeta,
      },
    }
    saveRunToHistory(run)
    setRunningCount(c => c + 1)

    let jobId
    try {
      jobId = await startEvaluationJob(req)
    } catch (e) {
      setRunningCount(c => Math.max(0, c - 1))
      runMeta.status = 'error'
      runMeta.error = e?.response?.data?.detail || e?.message || String(e)
      saveRunToHistory({ meta: runMeta, results: { ...run.results, meta: runMeta } })
      throw e
    }

    runMeta.job_id = jobId
    saveRunToHistory({ meta: runMeta, results: { ...run.results, meta: runMeta } })

    attachRunningJob({ runId, jobId, run, skipRunningCountBump: true })
    return { runId, jobId }
  }

  useEffect(() => {
    const runs = loadHistory()
    const running = runs.filter(r => r?.meta?.status === 'running' && r?.meta?.job_id)
    if (!running.length) return

    for (const r of running) {
      const runId = r.id
      const jobId = r.meta.job_id
      void (async () => {
        try {
          const snap = await fetchEvaluationResult(jobId)
          const nextMeta = {
            ...(r.meta || {}),
            status: snap.status,
            progress: snap.progress,
            error: snap.error,
            stats: snap.stats,
            metrics: snap.metrics ?? r.meta?.metrics,
            total: snap.total ?? r.meta?.total,
          }
          const nextResults = {
            ...(r.results || {}),
            rows: snap.rows || r.results?.rows || [],
            aggregate: snap.aggregate || r.results?.aggregate || {},
            metrics: snap.metrics || r.results?.metrics || [],
            total: snap.total ?? r.results?.total,
            meta: nextMeta,
          }
          saveRunToHistory({ meta: nextMeta, results: nextResults })

          if (snap.status === 'running') {
            const run = { meta: nextMeta, results: nextResults }
            run.results.meta = nextMeta
            attachRunningJob({ runId, jobId, run, skipRunningCountBump: false })
          }
        } catch {
          const nextMeta = { ...(r.meta || {}), status: 'interrupted' }
          saveRunToHistory({ meta: nextMeta, results: { ...(r.results || {}), meta: nextMeta } })
        }
      })()
    }
  }, [attachRunningJob])

  function reset() {
    setParsedFile(null)
    setEvalResults(null)
    setStep('upload')
  }

  function openHistory() {
    setStep('history')
  }

  function openRunFromHistory(entry) {
    const runId = entry?.id
    const latest = runId ? loadHistory().find(x => x.id === runId) : null
    const base = latest || entry
    const runMeta = { ...(base.meta || {}) }
    const run = {
      meta: runMeta,
      results: {
        ...(base.results || {}),
        rows: Array.isArray(base.results?.rows) ? [...base.results.rows] : [],
        meta: runMeta,
      },
    }
    setEvalResults(run.results)
    setStep('results')

    if (runMeta.status === 'running' && runMeta.job_id) {
      attachRunningJob({ runId, jobId: runMeta.job_id, run, skipRunningCountBump: false })
    }
  }

  function handleHistoryDelete(entry) {
    if (!entry?.id) return
    if (entry?.meta?.status === 'running') {
      const cancel = cancelByRunIdRef.current.get(entry.id)
      if (cancel) {
        void cancel()
      } else {
        setRunningCount(c => Math.max(0, c - 1))
        const jid = entry?.meta?.job_id
        if (jid) attachedJobIdsRef.current.delete(jid)
      }
      cancelByRunIdRef.current.delete(entry.id)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="bg-white border-b border-gray-200 py-4">
        <div className="w-[90vw] mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={reset}
              className="text-lg font-semibold text-gray-900 hover:underline underline-offset-4"
              title="Home"
            >
              LENS RAGAS Eval
            </button>
            <span className="text-sm text-gray-400">Quick RAG evaluation in the browser</span>
          </div>
          <div className="flex items-center gap-3">
            {runningSummary && <span className="text-xs text-gray-500 tabular-nums whitespace-nowrap">{runningSummary}</span>}
            <button
              onClick={openHistory}
              className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              History
            </button>
          </div>
        </div>
      </header>

      <main
        className="w-[90vw] mx-auto py-8 flex-1"
      >
        <Steps current={step} />

        {step === 'upload' && <Upload onParsed={handleParsed} onLoadScores={handleLoadScores} />}
        {step === 'configure' && (
          <Configure
            parsedFile={parsedFile}
            onStartRun={startRun}
            onOpenResults={res => {
              if (!res) return
              setEvalResults(res)
              setStep('results')
            }}
            onBack={reset}
          />
        )}
        {step === 'results' && (
          <Results results={evalResults} onReset={reset} />
        )}
        {step === 'history' && (
          <History
            onOpenRun={openRunFromHistory}
            onDeleteRun={handleHistoryDelete}
            onBack={() => setStep(evalResults ? 'results' : 'upload')}
          />
        )}
      </main>

      <Footer />
    </div>
  )
}

function Steps({ current }) {
  const steps = [
    { id: 'upload', label: 'Upload' },
    { id: 'configure', label: 'Configure' },
    { id: 'results', label: 'Results' },
  ]
  const idx = steps.findIndex(s => s.id === current)

  return (
    <div className="flex items-center gap-2 mb-8">
      {steps.map((s, i) => (
        <div key={s.id} className="flex items-center gap-2">
          <div className={`flex items-center justify-center w-7 h-7 rounded-full text-sm font-medium
            ${i < idx ? 'bg-green-500 text-white' : i === idx ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-500'}`}>
            {i < idx ? '✓' : i + 1}
          </div>
          <span className={`text-sm ${i === idx ? 'font-medium text-gray-900' : 'text-gray-400'}`}>{s.label}</span>
          {i < steps.length - 1 && <span className="text-gray-300 mx-1">›</span>}
        </div>
      ))}
    </div>
  )
}
