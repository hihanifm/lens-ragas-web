import { useEffect, useMemo, useRef, useState } from 'react'
import Upload from './pages/Upload'
import Configure from './pages/Configure'
import Results from './pages/Results'
import History from './pages/History'
import { loadHistory, saveRunToHistory } from './utils/history'
import { uuid } from './utils/uuid'
import Footer from './components/Footer'
import { cancelEvaluationJob, fetchEvaluationResult, startEvaluationJob, streamEvaluationJob } from './api/client'

export default function App() {
  const [step, setStep] = useState('upload') // upload | configure | results | history
  const [parsedFile, setParsedFile] = useState(null)
  const [evalResults, setEvalResults] = useState(null)
  const cancelByRunIdRef = useRef(new Map()) // runId -> cancelFn
  const [runningCount, setRunningCount] = useState(0)

  const runningSummary = useMemo(() => {
    if (runningCount <= 0) return null
    return `${runningCount} running`
  }, [runningCount])

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
    setStep('history')

    const jobId = await startEvaluationJob(req)
    runMeta.job_id = jobId
    saveRunToHistory({ meta: runMeta, results: { ...run.results, meta: runMeta } })

    const cancelStream = streamEvaluationJob(jobId, {
      onStart: ({ total, metrics }) => {
        runMeta.progress = { done: 0, total }
        runMeta.metrics = metrics || runMeta.metrics
        runMeta.total = total
        runMeta.status = 'running'
        saveRunToHistory({
          meta: runMeta,
          results: { ...run.results, metrics: runMeta.metrics, total, meta: runMeta },
        })
      },
      onRow: row => {
        run.results.rows.push(row)
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
        setRunningCount(c => Math.max(0, c - 1))
        cancelByRunIdRef.current.delete(runId)
      },
      onError: msg => {
        runMeta.status = msg === 'cancelled' ? 'cancelled' : 'error'
        runMeta.error = msg
        saveRunToHistory({ meta: runMeta, results: { ...run.results, meta: runMeta } })
        setRunningCount(c => Math.max(0, c - 1))
        cancelByRunIdRef.current.delete(runId)
      },
    })

    cancelByRunIdRef.current.set(runId, async () => {
      try {
        await cancelEvaluationJob(jobId)
      } catch {
        // ignore
      }
      cancelStream?.()
    })
  }

  useEffect(() => {
    // On load, reconcile any "running" runs by asking the backend for latest status.
    const runs = loadHistory()
    const running = runs.filter(r => r?.meta?.status === 'running' && r?.meta?.job_id)
    if (!running.length) return

    running.forEach(async r => {
      try {
        const snap = await fetchEvaluationResult(r.meta.job_id)
        const nextMeta = { ...(r.meta || {}), status: snap.status, progress: snap.progress, error: snap.error }
        const nextResults = {
          ...(r.results || {}),
          rows: snap.rows || r.results?.rows || [],
          aggregate: snap.aggregate || r.results?.aggregate || {},
          metrics: snap.metrics || r.results?.metrics || [],
          total: snap.total ?? r.results?.total,
          meta: nextMeta,
        }
        saveRunToHistory({ meta: nextMeta, results: nextResults })
      } catch {
        const nextMeta = { ...(r.meta || {}), status: 'interrupted' }
        saveRunToHistory({ meta: nextMeta, results: { ...(r.results || {}), meta: nextMeta } })
      }
    })
  }, [])

  function reset() {
    setParsedFile(null)
    setEvalResults(null)
    setStep('upload')
  }

  function openHistory() {
    setStep('history')
  }

  function openRunFromHistory(entry) {
    setEvalResults(entry.results)
    setStep('results')
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between gap-3">
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

      <main className="max-w-4xl mx-auto px-6 py-8 w-full flex-1">
        <Steps current={step} />

        {step === 'upload' && <Upload onParsed={handleParsed} onLoadScores={handleLoadScores} />}
        {step === 'configure' && (
          <Configure
            parsedFile={parsedFile}
            onStartRun={startRun}
            onBack={reset}
          />
        )}
        {step === 'results' && (
          <Results results={evalResults} onReset={reset} />
        )}
        {step === 'history' && (
          <History
            onOpenRun={openRunFromHistory}
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
