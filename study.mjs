const facts = [
  ['deadline', 'Deliverables', 'Finish the draft by Friday.', ['Finish the draft by Thursday.']],
  ['daily', 'Schedule', 'Study at most two hours per day.', ['Study at most three hours per day.']],
  ['wed', 'Schedule', 'Keep every Wednesday free.', ['Use Wednesday for catch-up work.']],
  ['sunday', 'Schedule', 'Keep Sundays free.', ['Keep Saturdays free.']],
  ['reserve', 'Schedule', 'Reserve at least 20% of available time.', ['Reserve at least 10% of available time.']],
  ['format', 'Deliverables', 'Include a weekly overview and dated work blocks.', ['Include the weekly overview only.']],
  ['order', 'Process', 'Read the papers before writing the synthesis.', ['Write the synthesis before reading the papers.']],
  ['scope', 'Process', 'Keep the first plan within the agreed scope.', ['Add another model comparison to the first plan.']],
]
const omitted = new Set(['wed', 'reserve'])

export function studyFixture(view) {
  if (!['items', 'summary'].includes(view)) throw new Error('Choose Itemized or Summary.')
  const request = 'Replan the remaining coursework.\n\n' + facts.filter(([id]) => !omitted.has(id)).map(([, , text]) => text).join('\n')
  const rows = facts.map(([id, group, text, alternatives], index) => ({
    id, group, text, source: 2 + index * 4, quote: text, options: [...alternatives, text].sort(),
  }))
  return { scenario: 'coursework-replan-v1', view, request, rows }
}

export function scoreTrial(trial, { marked, restorations, workload }, elapsedMs) {
  if (!Array.isArray(marked) || marked.some(id => !trial.rows.some(row => row.id === id))
    || !Number.isInteger(workload) || workload < 1 || workload > 7 || !restorations || typeof restorations !== 'object') {
    throw new Error('Mark the missing items and enter a workload rating from 1 to 7.')
  }
  const selected = new Set(marked)
  const restored = trial.rows.filter(row => selected.has(row.id) && row.options.includes(restorations[row.id]))
  const hits = [...omitted].filter(id => selected.has(id))
  const falseAlarms = [...selected].filter(id => !omitted.has(id))
  const accurate = restored.filter(row => omitted.has(row.id) && restorations[row.id] === row.text)
  const request = [trial.request, ...restored.map(row => restorations[row.id])].join('\n')
  return {
    scenario: trial.scenario, view: trial.view, durationMs: elapsedMs, workload,
    hits, misses: [...omitted].filter(id => !selected.has(id)), falseAlarms,
    accurateRestorations: accurate.map(row => row.id), incorrectRestorations: restored.filter(row => !accurate.includes(row)).map(row => row.id),
    request,
  }
}
