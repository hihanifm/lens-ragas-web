import { useRef, useState } from 'react'
import { parseFile } from '../api/client'
import { parseExportedScoresCsv } from '../utils/scoresCsv'

export default function Upload({ onParsed, onLoadScores }) {
  const inputRef = useRef()
  const scoresRef = useRef()
  const [dragging, setDragging] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  async function handleFile(file) {
    if (!file) return
    setError(null)
    setLoading(true)
    try {
      const data = await parseFile(file)
      onParsed({ ...data, input_filename: file.name })
    } catch (e) {
      setError(e.response?.data?.detail || e.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleScoresFile(file) {
    if (!file) return
    setError(null)
    setLoading(true)
    try {
      const text = await file.text()
      const results = parseExportedScoresCsv(text)
      onLoadScores?.({
        ...results,
        meta: {
          input_filename: file.name,
          loaded_from: 'scores_csv',
          createdAt: new Date().toISOString(),
        },
      })
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-8">
      <h2 className="text-lg font-semibold text-gray-900 mb-1">Upload evaluation file</h2>
      <p className="text-sm text-gray-500 mb-6">
        Accepts <code className="bg-gray-100 px-1 rounded">.json</code> (LENS export) or{' '}
        <code className="bg-gray-100 px-1 rounded">.csv</code> with columns:{' '}
        <code className="bg-gray-100 px-1 rounded">question</code>,{' '}
        <code className="bg-gray-100 px-1 rounded">contexts</code>,{' '}
        <code className="bg-gray-100 px-1 rounded">ground_truth</code>,{' '}
        <code className="bg-gray-100 px-1 rounded">answer</code> (optional)
      </p>

      <div
        className={`border-2 border-dashed rounded-lg p-12 text-center cursor-pointer transition-colors
          ${dragging ? 'border-blue-400 bg-blue-50' : 'border-gray-300 hover:border-gray-400'}`}
        onClick={() => inputRef.current.click()}
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); handleFile(e.dataTransfer.files[0]) }}
      >
        {loading ? (
          <p className="text-gray-500">Parsing file...</p>
        ) : (
          <>
            <p className="text-gray-700 font-medium">Drop file here or click to browse</p>
            <p className="text-sm text-gray-400 mt-1">.json or .csv</p>
          </>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept=".json,.csv"
        className="hidden"
        onChange={e => handleFile(e.target.files[0])}
      />

      <div className="mt-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <p className="text-xs text-gray-500">
          Already have exported scores? Load the exported CSV to view results without re-running.
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => scoresRef.current.click()}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50"
          >
            Load scores CSV
          </button>
          <input
            ref={scoresRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={e => handleScoresFile(e.target.files[0])}
          />
        </div>
      </div>

      {error && (
        <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}
    </div>
  )
}
