const METRIC_LABELS = {
  faithfulness: 'Faithfulness',
  answer_relevancy: 'Answer Relevancy',
  context_precision: 'Context Precision',
  context_recall: 'Context Recall',
}

export default function Results({ results, onReset }) {
  const { rows, aggregate, metrics, meta } = results

  function exportCsv() {
    const metaLines = []
    if (meta?.lens_metadata) {
      try {
        metaLines.push(`# lens_metadata: ${JSON.stringify(meta.lens_metadata)}`)
      } catch {
        // ignore if metadata isn't serializable
      }
    }

    const header = ['question', ...metrics].join(',')
    const lines = rows.map(r =>
      [
        `"${(r.question || '').replace(/"/g, '""')}"`,
        ...metrics.map(m => r.scores[m] ?? ''),
      ].join(',')
    )
    const aggLine = ['"AGGREGATE"', ...metrics.map(m => aggregate[m] ?? '')].join(',')
    const csv = [...metaLines, header, ...lines, aggLine].join('\n')

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
      {/* Aggregate summary */}
      <div className="bg-white rounded-xl border border-gray-200 p-5" data-testid="results-aggregate">
        <h2 className="text-sm font-semibold text-gray-900 mb-4">Aggregate scores ({rows.length} rows)</h2>
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

      {/* Per-row table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">#</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Question</th>
                {metrics.map(m => (
                  <th key={m} className="text-center px-4 py-3 font-medium text-gray-600 whitespace-nowrap">
                    {METRIC_LABELS[m] || m}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-400">{i + 1}</td>
                  <td className="px-4 py-3 text-gray-800 whitespace-normal min-w-[280px]">
                    {row.question}
                  </td>
                  {metrics.map(m => (
                    <td key={m} className={`px-4 py-3 text-center font-medium ${scoreColor(row.scores[m])}`}>
                      {row.scores[m] != null ? row.scores[m].toFixed(3) : '—'}
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
          className="px-6 py-2 text-sm bg-green-600 text-white rounded-lg font-medium hover:bg-green-700">
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
