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

  const meta = {}

  function ingestMetaLine(raw) {
    const line = String(raw || '').trim().replace(/^#\s?/, '')
    const m = line.match(/^([a-zA-Z0-9_.-]+)\s*:\s*(.*)$/)
    if (!m) return
    const key = m[1]
    const val = m[2]
    if (key === 'lens_metadata') {
      try {
        meta.lens_metadata = JSON.parse(val)
      } catch {
        // ignore parse errors; keep file importable
      }
    } else {
      meta[key] = val
    }
  }

  // Support legacy metadata comments at the top OR bottom (or anywhere).
  for (const l of lines) {
    if (String(l).trim().startsWith('#')) ingestMetaLine(l)
  }

  const dataLines = lines.filter(l => !String(l).trim().startsWith('#'))
  if (!dataLines.length) throw new Error('CSV is empty.')

  const header = parseCsvLine(dataLines[0])
  if (header.length < 2 || header[0] !== 'question') {
    throw new Error('Not a recognized scores CSV (expected first column "question").')
  }

  const lensMetaIdx = header.indexOf('lens_metadata')
  const metrics = header
    .slice(1)
    .filter(c => c && c !== 'lens_metadata')
  const rows = []
  let aggregate = {}

  for (let i = 1; i < dataLines.length; i++) {
    const cols = parseCsvLine(dataLines[i])
    if (!cols.length) continue
    const q = cols[0]
    const scores = {}
    for (let j = 0; j < metrics.length; j++) {
      const colIdx = header.indexOf(metrics[j])
      scores[metrics[j]] = toNumberOrNull(colIdx >= 0 ? cols[colIdx] : cols[j + 1])
    }

    if (q === 'AGGREGATE') {
      aggregate = { ...scores }
      if (lensMetaIdx >= 0 && cols[lensMetaIdx] && !meta.lens_metadata) {
        try {
          meta.lens_metadata = JSON.parse(String(cols[lensMetaIdx]))
        } catch {
          // ignore parse errors; keep file importable
        }
      }
    } else {
      rows.push({ index: rows.length, question: q, scores })
    }
  }

  return {
    rows,
    aggregate,
    metrics,
    total: rows.length,
    meta,
  }
}

