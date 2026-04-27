function parseCsvLine(line) {
  const out = []
  let cur = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        const next = line[i + 1]
        if (next === '"') {
          cur += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cur += ch
      }
    } else {
      if (ch === '"') inQuotes = true
      else if (ch === ',') {
        out.push(cur)
        cur = ''
      } else {
        cur += ch
      }
    }
  }
  out.push(cur)
  return out
}

function toNumberOrNull(v) {
  if (v == null) return null
  const s = String(v).trim()
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

export function parseExportedScoresCsv(text) {
  const lines = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter(l => l.trim().length > 0)

  if (!lines.length) throw new Error('CSV is empty.')

  const header = parseCsvLine(lines[0])
  if (header.length < 2 || header[0] !== 'question') {
    throw new Error('Not a recognized scores CSV (expected first column "question").')
  }

  const metrics = header.slice(1)
  const rows = []
  let aggregate = {}

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i])
    if (!cols.length) continue
    const q = cols[0]
    const scores = {}
    for (let j = 0; j < metrics.length; j++) {
      scores[metrics[j]] = toNumberOrNull(cols[j + 1])
    }

    if (q === 'AGGREGATE') {
      aggregate = { ...scores }
    } else {
      rows.push({ index: rows.length, question: q, scores })
    }
  }

  return {
    rows,
    aggregate,
    metrics,
    total: rows.length,
  }
}

