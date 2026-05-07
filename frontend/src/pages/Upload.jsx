import { useMemo, useRef, useState } from 'react'
import { applyParseColumnMap, parseFile } from '../api/client'
import { parseExportedScoresCsv } from '../utils/scoresCsv'
const SAMPLE_FILENAME = 'sample-dataset.json'
const SAMPLE_SCORES_FILENAME = 'sample-scores.csv'

const PREVIEW_ROWS = 5
const TRUNCATE_CHARS = 140

function truncateCell(v, max = TRUNCATE_CHARS) {
  const s = typeof v === 'string' ? v : v == null ? '' : String(v)
  if (s.length <= max) return s
  return s.slice(0, max) + '…'
}

function tryParseJson(v) {
  if (v == null) return null
  const s = String(v).trim()
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

// Minimal CSV parser: handles quotes + commas; not meant for edge-case perfection.
function parseCsv(text) {
  const rows = []
  let row = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cur += ch
      }
    } else {
      if (ch === '"') {
        inQuotes = true
      } else if (ch === ',') {
        row.push(cur)
        cur = ''
      } else if (ch === '\n') {
        row.push(cur)
        rows.push(row)
        row = []
        cur = ''
      } else if (ch === '\r') {
        // ignore
      } else {
        cur += ch
      }
    }
  }
  // trailing cell
  row.push(cur)
  rows.push(row)
  return rows.filter(r => r.some(c => String(c ?? '').trim() !== ''))
}

async function buildPreview(file) {
  if (!file) return null
  const name = String(file.name || '').toLowerCase()
  if (name.endsWith('.xlsx')) return null
  const text = await file.text()

  if (name.endsWith('.json')) {
    const parsed = tryParseJson(text)
    const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.results) ? parsed.results : []
    const previewRows = arr
      .filter(x => x && typeof x === 'object')
      .slice(0, PREVIEW_ROWS)
      .map(r => ({ ...r }))
    const columns = Array.from(
      new Set(
        previewRows.flatMap(r => Object.keys(r || {}))
      )
    )
    return { columns, rows: previewRows }
  }

  if (name.endsWith('.csv')) {
    const matrix = parseCsv(text.replace(/\r\n/g, '\n'))
    if (!matrix.length) return { columns: [], rows: [] }
    const header = (matrix[0] || []).map(h => String(h || '').trim())
    const dataRows = matrix.slice(1, 1 + PREVIEW_ROWS).map(cols => {
      const obj = {}
      header.forEach((h, idx) => {
        obj[h || `col_${idx + 1}`] = cols[idx] ?? ''
      })
      // Try to normalize contexts into array for nicer rendering.
      if (Object.prototype.hasOwnProperty.call(obj, 'contexts')) {
        const p = tryParseJson(obj.contexts)
        if (Array.isArray(p)) obj.contexts = p
      }
      return obj
    })
    const columns = header.filter(Boolean)
    return { columns, rows: dataRows }
  }

  return null
}

export default function Upload({ onParsed, onLoadScores, runningCount = 0, onCancelAllRunning }) {
  const inputRef = useRef()
  const scoresRef = useRef()
  const [dragging, setDragging] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [preview, setPreview] = useState(null) // { columns: string[], rows: object[] }
  const [parsedReady, setParsedReady] = useState(null) // parsedFile payload to pass to Configure
  const [mapping, setMapping] = useState(null) // { file_id, columns, column_map }
  const [project, setProject] = useState(() => localStorage.getItem('lens-ragas-web:project:v1') || '')

  const mappingColumns = mapping?.columns || []
  const mappingReady = useMemo(() => {
    if (!mapping) return false
    const cm = mapping.column_map || {}
    return Boolean(cm.question && cm.contexts)
  }, [mapping])

  async function handleFile(file) {
    if (!file) return
    setError(null)
    setLoading(true)
    setPreview(null)
    setParsedReady(null)
    setMapping(null)
    try {
      // Client-side preview (top 5 rows) so the user can sanity-check the file.
      try {
        const p = await buildPreview(file)
        setPreview(p)
      } catch {
        setPreview(null)
      }
      const data = await parseFile(file)
      const withName = { ...data, input_filename: file.name }
      if (withName?.needs_column_mapping) {
        setMapping({
          file_id: withName.file_id,
          columns: withName.columns || [],
          column_map: { question: '', contexts: '', ground_truth: '', answer: '' },
          input_filename: file.name,
        })
      } else {
        setParsedReady(withName)
      }
    } catch (e) {
      setError(e.response?.data?.detail || e.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleSample() {
    setError(null)
    setLoading(true)
    try {
      // Fetch from Vite's public dir (same origin, no CORS issues)
      const res = await fetch(`${location.origin}/${SAMPLE_FILENAME}`)
      if (!res.ok) throw new Error('Could not load sample file')
      const blob = await res.blob()
      const file = new File([blob], SAMPLE_FILENAME, { type: 'application/json' })
      await handleFile(file)
    } catch (e) {
      setError(e.message)
      setLoading(false)
    }
  }

  async function handleSampleScores() {
    setError(null)
    setLoading(true)
    try {
      const res = await fetch(`${location.origin}/${SAMPLE_SCORES_FILENAME}`)
      if (!res.ok) throw new Error('Could not load sample scores file')
      const blob = await res.blob()
      const file = new File([blob], SAMPLE_SCORES_FILENAME, { type: 'text/csv' })
      await handleScoresFile(file)
    } catch (e) {
      setError(e.message)
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
          ...(results.meta || {}),
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
        Accepts <code className="bg-gray-100 px-1 rounded">.json</code> (LENS export),{' '}
        <code className="bg-gray-100 px-1 rounded">.csv</code>, or{' '}
        <code className="bg-gray-100 px-1 rounded">.xlsx</code> with columns:{' '}
        <code className="bg-gray-100 px-1 rounded">question</code>,{' '}
        <code className="bg-gray-100 px-1 rounded">contexts</code>,{' '}
        <code className="bg-gray-100 px-1 rounded">ground_truth</code>,{' '}
        <code className="bg-gray-100 px-1 rounded">answer</code> (optional)
      </p>

      {runningCount > 0 && onCancelAllRunning && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm">
          <span className="text-amber-900">
            <span className="font-medium tabular-nums">{runningCount}</span> evaluation{runningCount === 1 ? '' : 's'} still
            running (see <span className="font-medium">History</span>).
          </span>
          <button
            type="button"
            onClick={() => onCancelAllRunning()}
            className="px-3 py-1.5 text-xs font-medium bg-white border border-amber-300 rounded-lg text-amber-900 hover:bg-amber-100 shrink-0"
          >
            Cancel all
          </button>
        </div>
      )}

      <div className="mb-5">
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Project (optional)</h3>
        <p className="text-xs text-gray-500 mb-2">
          Use the same project name on multiple PCs to group runs together on the server. Leave blank for the default
          project.
        </p>
        <input
          value={project}
          onChange={e => {
            const v = e.target.value
            setProject(v)
            try {
              localStorage.setItem('lens-ragas-web:project:v1', v || '')
            } catch {
              // ignore
            }
          }}
          placeholder="default"
          className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div
        className={`border-2 border-dashed rounded-lg p-12 text-center cursor-pointer transition-colors
          ${dragging ? 'border-blue-400 bg-blue-50' : 'border-gray-300 hover:border-gray-400'}`}
        data-testid="upload-dropzone"
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
            <p className="text-sm text-gray-400 mt-1">.json, .csv, or .xlsx</p>
            <p className="text-sm text-gray-400 mt-3">
              or{' '}
              <button
                type="button"
                onClick={e => { e.stopPropagation(); handleSample() }}
                className="text-blue-600 hover:underline focus:outline-none"
              >
                load the sample dataset
              </button>{' '}
              to try it out
            </p>
          </>
        )}
      </div>

      {mapping && !loading && !error && (
        <div className="mt-4 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
          <div className="text-sm text-amber-900">
            <span className="font-medium">Column names don’t match.</span>{' '}
            Choose which columns contain the required fields.
          </div>
          <p className="text-xs text-amber-800/90 mt-1">
            For <span className="font-medium">contexts</span>, pick the column that contains the retrieved passages (often a JSON list like
            <code className="mx-1 bg-white/60 px-1 rounded">[\"ctx1\",\"ctx2\"]</code>).
          </p>

          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Select
              label="question (required)"
              value={mapping.column_map.question}
              options={mappingColumns}
              onChange={v => setMapping(m => ({ ...m, column_map: { ...(m.column_map || {}), question: v } }))}
            />
            <Select
              label="contexts (required)"
              value={mapping.column_map.contexts}
              options={mappingColumns}
              onChange={v => setMapping(m => ({ ...m, column_map: { ...(m.column_map || {}), contexts: v } }))}
            />
            <Select
              label="ground_truth (optional)"
              allowNone
              value={mapping.column_map.ground_truth}
              options={mappingColumns}
              onChange={v => setMapping(m => ({ ...m, column_map: { ...(m.column_map || {}), ground_truth: v } }))}
            />
            <Select
              label="answer (optional)"
              allowNone
              value={mapping.column_map.answer}
              options={mappingColumns}
              onChange={v => setMapping(m => ({ ...m, column_map: { ...(m.column_map || {}), answer: v } }))}
            />
          </div>

          <div className="mt-3 flex items-center justify-between gap-3">
            <div className="text-xs text-amber-800/80">
              File: <span className="font-mono">{mapping?.input_filename}</span>
            </div>
            <button
              type="button"
              disabled={!mappingReady || loading}
              onClick={async () => {
                try {
                  setLoading(true)
                  const cm = { ...(mapping.column_map || {}) }
                  if (!cm.ground_truth) delete cm.ground_truth
                  if (!cm.answer) delete cm.answer
                  const parsed = await applyParseColumnMap({ file_id: mapping.file_id, column_map: cm })
                  setParsedReady({ ...parsed, input_filename: mapping.input_filename })
                  setMapping(null)
                } catch (e) {
                  setError(e?.response?.data?.detail || e?.message || String(e))
                } finally {
                  setLoading(false)
                }
              }}
              className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50"
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {parsedReady && !loading && !error && (
        <div className="mt-4 flex items-center justify-between gap-3 bg-blue-50 border border-blue-200 rounded-lg px-4 py-3">
          <div className="text-sm text-blue-900">
            <span className="font-medium">File parsed.</span>{' '}
            <span className="text-blue-900/90">
              {parsedReady.row_count} rows · {parsedReady.format}
            </span>
          </div>
          <button
            type="button"
            onClick={() => onParsed?.(parsedReady)}
            className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
          >
            Continue
          </button>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept=".json,.csv,.xlsx"
        className="hidden"
        data-testid="upload-input"
        onChange={e => handleFile(e.target.files[0])}
      />

      <div className="mt-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <p className="text-xs text-gray-500">
          Already have exported scores? Load the exported CSV to view results without re-running,{' '}
          or{' '}
          <button
            type="button"
            onClick={handleSampleScores}
            disabled={loading}
            className="text-blue-600 hover:underline focus:outline-none disabled:opacity-50"
          >
            load the sample scores
          </button>
          .
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => scoresRef.current.click()}
            disabled={loading}
            data-testid="load-scores-csv"
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

      {preview?.rows?.length ? (
        <div className="mt-6">
          <div className="flex items-center justify-between gap-3 mb-2">
            <h3 className="text-sm font-semibold text-gray-900">Preview (first {Math.min(PREVIEW_ROWS, preview.rows.length)} rows)</h3>
            <p className="text-xs text-gray-500">Values are truncated for readability.</p>
          </div>
          <div className="border border-gray-200 rounded-lg overflow-hidden bg-white">
            <div className="overflow-x-auto">
              <table className="w-max min-w-full text-xs">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    {(preview.columns?.length ? preview.columns : Object.keys(preview.rows[0] || {})).map(col => (
                      <th
                        key={col}
                        className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap"
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r, idx) => {
                    const cols = preview.columns?.length ? preview.columns : Object.keys(r || {})
                    return (
                      <tr key={idx} className="border-b border-gray-100 last:border-b-0">
                        {cols.map(col => {
                          const raw = r?.[col]
                          const normalized =
                            col === 'contexts' && Array.isArray(raw)
                              ? raw.map(x => String(x ?? '')).join(' | ')
                              : typeof raw === 'object' && raw != null
                                ? JSON.stringify(raw)
                                : raw
                          return (
                            <td key={col} className="px-3 py-2 align-top text-gray-700">
                              <div className="max-w-[340px] whitespace-pre-wrap break-words">
                                {truncateCell(normalized)}
                              </div>
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function Select({ label, value, options, onChange, allowNone }) {
  return (
    <div>
      <label className="block text-xs font-medium text-amber-900/90 mb-1">{label}</label>
      <select
        value={value || ''}
        onChange={e => onChange?.(e.target.value)}
        className="w-full text-sm border border-amber-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-amber-500"
      >
        <option value="">{allowNone ? 'None' : 'Select…'}</option>
        {(options || []).map(o => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  )
}
