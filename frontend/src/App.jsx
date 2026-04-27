import { useState } from 'react'
import Upload from './pages/Upload'
import Configure from './pages/Configure'
import Results from './pages/Results'
import History from './pages/History'
import { saveRunToHistory } from './utils/history'

export default function App() {
  const [step, setStep] = useState('upload') // upload | configure | results | history
  const [parsedFile, setParsedFile] = useState(null)
  const [evalResults, setEvalResults] = useState(null)

  function handleParsed(data) {
    setParsedFile(data)
    setStep('configure')
  }

  function handleResults(data, meta = {}) {
    const run = {
      meta: {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        ...meta,
        metrics: data?.metrics,
        total: data?.total ?? data?.rows?.length,
      },
      results: data,
    }
    saveRunToHistory(run)

    setEvalResults(data)
    setStep('results')
  }

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
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="text-lg font-semibold text-gray-900">LENS RAGAS Eval</span>
            <span className="text-sm text-gray-400">Quick RAG evaluation in the browser</span>
          </div>
          <button
            onClick={openHistory}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
          >
            History
          </button>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8">
        <Steps current={step} />

        {step === 'upload' && <Upload onParsed={handleParsed} />}
        {step === 'configure' && (
          <Configure parsedFile={parsedFile} onResults={handleResults} onBack={reset} />
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
