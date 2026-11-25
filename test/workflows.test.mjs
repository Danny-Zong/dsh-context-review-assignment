import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectRequest, scopedDecision, withScopeDecisions } from '../context.mjs'
import { scoreTrial, studyFixture } from '../study.mjs'

const old = { source: 3, quote: 'Keep every Wednesday free.', id: 'old', status: 'active' }
const proposal = {
  source: 9, quote: 'Wednesdays might be free in November.', id: 'new', status: 'uncertain',
  scope: { prior: old, certainty: 'tentative' },
}

test('a confirmed temporary change preserves the original rule whenever its condition does not hold', () => {
  assert.throws(() => scopedDecision(proposal, { action: 'apply', condition: '   ', text: 'Allow Wednesdays.' }), /when the change applies/)
  assert.throws(() => scopedDecision(proposal, { action: 'apply', condition: 'x'.repeat(301), text: 'Allow Wednesdays.' }), /when the change applies/)
  const rule = scopedDecision(proposal, { action: 'apply', condition: 'for the November   plan', text: 'Allow Wednesday work.' })
  assert.equal(rule.certainty, 'confirmed')
  assert.equal(rule.condition, 'for the November plan')
  assert.match(rule.text, /^When for the November plan: Allow Wednesday work\.\nOtherwise keep the original requirement: Keep every Wednesday free\./)
  const candidates = withScopeDecisions([old, proposal], [rule])
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].scope.resolved.text, rule.text)
  const retained = scopedDecision(proposal, { action: 'keep' })
  assert.match(retained.text, /^Keep the original requirement: Keep every Wednesday free\./)
})

test('prepared coverage distinguishes quoted assistant wording from user-approved wording', () => {
  const text = value => [{ type: 'text', text: value }]
  const options = { model: 'offline', messages: [{ role: 'assistant', content: text(old.quote) }] }
  const onlyAssistant = inspectRequest(options, [old]).requirements[0]
  assert.equal(onlyAssistant.present, false)
  assert.deepEqual(onlyAssistant.roles, ['assistant'])
  options.messages.push({ role: 'user', content: text('Do not schedule Wednesday study.') })
  const restored = inspectRequest(options, [{ ...old, approvedText: 'Do not schedule Wednesday study.' }]).requirements[0]
  assert.equal(restored.present, true)
  assert.equal(restored.approvedPresent, true)
})

test('both study conditions share evidence and score identical actions equally', () => {
  const items = studyFixture('items')
  const summary = studyFixture('summary')
  assert.deepEqual(items.rows, summary.rows)
  assert.equal(items.request, summary.request)
  assert.ok(!items.request.includes('Keep every Wednesday free.'))
  assert.ok(!items.request.includes('Reserve at least 20% of available time.'))
  const answers = { marked: ['wed', 'reserve', 'daily'], restorations: {
    wed: 'Keep every Wednesday free.', reserve: 'Reserve at least 10% of available time.', daily: 'Study at most two hours per day.',
  }, workload: 3 }
  const a = scoreTrial(items, answers, 1000)
  const b = scoreTrial(summary, answers, 1000)
  assert.deepEqual(a, { ...b, view: 'items' })
  assert.deepEqual(a.accurateRestorations, ['wed'])
  assert.deepEqual(a.falseAlarms, ['daily'])
  assert.deepEqual(a.incorrectRestorations, ['daily', 'reserve'])
})
