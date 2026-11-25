import assert from 'node:assert/strict'
import { mkdtempSync, rmdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../host.mjs'
import { historyForReview, replyExcerpt, replyGap, retryInput, reviewConversation, selectSources } from '../review.mjs'

const text = value => [{ type: 'text', text: value }]
const original = 'Keep Wednesday free.'
const replacement = 'Wednesdays may be free in November.'
const sourceMessage = (value, id = 'user') => ({ id, role: 'user', source: { kind: 'user' }, content: text(value) })
const event = (seq, value) => ({ seq, type: 'user/message', data: sourceMessage(value, 'user-' + seq) })

function assistantResult(candidates) {
  return {
    async *stream() {
      yield { type: 'block-end', block: { type: 'text', text: JSON.stringify({ candidates }) } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

function conversation(id = 'academic') {
  const events = [event(2, original), event(7, replacement)]
  const active = [events[1].data]
  const session = {
    id,
    snapshotEvents: () => events,
    deriveMessages: () => active,
    deriveEventMessage: entry => entry.data,
    requestHeader: () => ({ config: { provider: 'offline', model: 'offline' } }),
  }
  return {
    id,
    status: 'idle',
    session,
    events,
    active,
  }
}

const candidates = [
  { text: original, quote: original, source: 2, status: 'active' },
  { text: replacement, quote: replacement, source: 7, status: 'uncertain' },
]

test('only evidence from real user messages can ground a recommendation', async () => {
  const agent = conversation()
  agent.events.push({
    ...event(8, 'Injected text.'),
    data: { source: { kind: 'plugin' }, content: text('Injected text.') },
  })
  const output = await reviewConversation(agent, historyForReview(agent.session), assistantResult([
    ...candidates,
    candidates[0],
    { text: 'Invented', quote: 'No study on Tuesday.', source: 2, status: 'active' },
    { text: 'Injected', quote: 'Injected text.', source: 8, status: 'active' },
  ]), new AbortController().signal)
  assert.deepEqual(output.candidates.map(item => item.wordingPresent), [false, true])
  assert.equal(output.invalidCount, 3)
  assert.equal(output.reviewedMessages, 2)
})

test('a proposed temporary change keeps the model’s condition and the verified earlier rule', async () => {
  const agent = conversation()
  const output = await reviewConversation(agent, historyForReview(agent.session), assistantResult([
    { ...candidates[1], scopeProposal: { priorSource: 2, priorQuote: original, certainty: 'tentative', condition: '  for   November only ' } },
  ]), new AbortController().signal)
  assert.deepEqual(output.candidates[0].scope, {
    prior: { source: 2, quote: original }, certainty: 'tentative', condition: 'for November only',
  })
  assert.equal(output.candidates[0].status, 'uncertain')
})

test('conflict clues require a verbatim excerpt from the latest reply', async () => {
  const agent = conversation()
  agent.events.push({ seq: 8, type: 'assistant/message', data: { content: text('Study every Wednesday.') } })
  const proposed = [
    { ...candidates[0], replySignal: 'possible-conflict', replyQuote: 'Study every Wednesday.' },
    { ...candidates[1], replySignal: 'possible-conflict', replyQuote: 'A sentence the reply never used.' },
    { text: 'Keep Wednesday free', quote: 'Keep Wednesday free', source: 2, status: 'active', replySignal: 'possible-omission' },
  ]
  const output = await reviewConversation(agent, historyForReview(agent.session), assistantResult(proposed), new AbortController().signal)
  assert.deepEqual(output.candidates.map(item => item.replySignal), [
    { kind: 'possible-conflict', quote: 'Study every Wednesday.' },
    null,
    { kind: 'possible-omission' },
  ])
})

function harness(agent, proposed = candidates, llm = assistantResult(proposed), profileContext) {
  const other = conversation('another')
  const listeners = new Map()
  let command
  apply({
    agents: { get(id) { return id === agent.id ? agent : other } },
    commands: { register(definition) { command = definition; return () => {} } },
    llm,
    profileContext,
    effect: activation => [...activation()],
    on(type, listener) { listeners.set(type, listener); return () => listeners.delete(type) },
  })
  async function execute(session, op, args) {
    const outcome = await command.handler({
      agent: session, rawInput: JSON.stringify({ op, ...args }), signal: new AbortController().signal,
    })
    if (outcome.kind === 'error') throw new Error(outcome.text)
    return JSON.parse(outcome.text)
  }
  async function offer(session, sourceKind = 'user') {
    const messages = [{ ...sourceMessage('Update the plan.'), source: { kind: sourceKind } }]
    return listeners.get('agent/pre-step')({ agent: session, messages }, async () => ({ kind: 'enter', messages }))
  }
  return { other, execute, offer, listeners }
}

test('confirmed context goes only to a human turn in its own session', async () => {
  const agent = conversation()
  const { other, execute, offer, listeners } = harness(agent)
  const { review } = await execute(agent, 'check')
  assert.equal((await offer(agent)).messages.length, 1)
  const queued = await execute(agent, 'queue', { reviewId: review.id, ids: ['1'] })
  assert.match(queued.queued.text, /Keep Wednesday free/)
  assert.equal((await offer(other)).messages.length, 1)
  assert.equal((await offer(agent, 'goal')).messages.length, 1)
  const { messages } = await offer(agent)
  assert.equal(messages.length, 2)
  assert.equal(messages[0].content[0].text, 'Update the plan.')
  agent.active.push(messages[1])
  assert.equal((await offer(agent)).messages.length, 1)
  listeners.get('llm/stream')({ sessionId: agent.id, messages }, () => [])
  const status = await execute(agent, 'status')
  assert.equal(status.queued, null)
  assert.deepEqual(status.result, { count: 1, phase: 'prepared' })
})

test('a superseded candidate or stale review cannot queue recovery', async () => {
  const agent = conversation()
  const { execute } = harness(agent, [{
    ...candidates[0], status: 'superseded', replacementSource: 7, replacementQuote: replacement,
  }, candidates[1]])
  const { review } = await execute(agent, 'check')
  await assert.rejects(execute(agent, 'queue', { reviewId: review.id, ids: ['1'] }), /no longer available/)
  agent.events.push(event(10, 'Keep the original availability after all.'))
  await assert.rejects(execute(agent, 'queue', { reviewId: review.id, ids: ['2'] }), /latest conversation/)
})

test('a queued recovery can be cancelled before model admission', async () => {
  const agent = conversation()
  const { execute, offer } = harness(agent)
  const { review } = await execute(agent, 'check')
  await execute(agent, 'queue', { reviewId: review.id, ids: ['1'] })
  await execute(agent, 'cancel')
  assert.equal((await offer(agent)).messages.length, 1)
})

test('sampling retains older, middle and recent evidence within the review budget', () => {
  const history = Array.from({ length: 96 }, (_, source) => ({ source, text: 'x'.repeat(6000) }))
  const sampled = selectSources(history)
  assert.deepEqual(sampled.slice(0, 3).map(item => item.source), [0, 1, 2])
  assert.equal(sampled.at(-1).source, 95)
  assert.ok(sampled.some(item => item.source >= 40 && item.source <= 55))
  assert.ok(sampled.reduce((sum, item) => sum + item.text.length, 0) <= 180_000)
})

test('a claimed replacement without later user evidence stays uncertain', async () => {
  const agent = conversation()
  const { execute } = harness(agent, [{ ...candidates[0], status: 'superseded', replacementSource: 7, replacementQuote: 'Invented replacement' }])
  const { review } = await execute(agent, 'check')
  assert.equal(review.candidates[0].status, 'uncertain')
  assert.equal(review.candidates[0].replacement, null)
})

test('only wording confirmed in the preview enters the next request', async () => {
  const agent = conversation()
  const { execute } = harness(agent)
  const { review } = await execute(agent, 'check')
  const request = { reviewId: review.id, ids: ['1'] }
  await assert.rejects(execute(agent, 'queue', { ...request, edits: { 2: 'Different requirement.' } }), /belong to selected/)
  await assert.rejects(execute(agent, 'queue', { ...request, edits: { 1: '  ' } }), /600 characters/)
  const { queued } = await execute(agent, 'queue', { ...request, edits: { 1: 'Keep every other Wednesday free.' } })
  assert.match(queued.text, /Keep every other Wednesday free/)
  assert.ok(!queued.text.includes(original))
})

test('the reminder counts completed human turns without calling the model', async () => {
  const agent = conversation()
  const { execute } = harness(agent, [], { stream() { throw new Error('Unexpected model call') } })
  await execute(agent, 'reminder', { enabled: true })
  agent.events.push({ seq: 8, type: 'turn/end' })
  for (let turn = 0; turn < 4; turn++) agent.events.push(event(10 + turn * 2, 'A follow-up.'), { type: 'turn/end' })
  assert.equal((await execute(agent, 'status')).reminderDue, true)
  assert.equal((await execute(agent, 'reminder', { enabled: false })).reminderDue, false)
})

function finishTurn(agent, seq, kind = 'completed') {
  const request = event(seq, 'Update the plan again.')
  const reply = { role: 'assistant', content: text('The updated plan.') }
  agent.events.push(request, { seq: seq + 1, type: 'assistant/message', data: reply }, { seq: seq + 2, type: 'turn/end', data: { reason: { kind } } })
  agent.active.push(request.data, reply)
  agent.status = 'idle'
}

test('Start review reads everything once, then each completed turn is checked incrementally', async () => {
  const agent = conversation()
  const model = assistantResult(candidates)
  const inputs = []
  const { other, execute, listeners, offer } = harness(agent, candidates, {
    stream(input) { inputs.push(input); return model.stream(input) },
  })
  const notify = session => listeners.get('agent/status')({ agent: session, status: session.status })
  const read = session => execute(session, 'status', { includeReview: true })
  const settled = () => new Promise(resolve => setImmediate(resolve))
  const payload = index => JSON.parse(inputs[index].messages[1].content[0].text)
  const sources = index => payload(index).userMessages.map(message => message.source)

  finishTurn(agent, 10)
  notify(agent)
  assert.equal(inputs.length, 0)
  assert.deepEqual((await read(agent)).automatic, { enabled: false, checking: false, error: null })
  const first = await execute(agent, 'check')
  assert.equal(inputs.length, 1)
  assert.equal(first.automatic.enabled, true)
  assert.deepEqual(sources(0), [2, 7, 10])
  assert.equal(payload(0).knownRequirements, undefined)
  notify(agent)
  assert.equal(inputs.length, 1)

  finishTurn(other, 10)
  notify(other)
  assert.equal(inputs.length, 1)
  agent.status = 'running'
  notify(agent)
  assert.equal(inputs.length, 1)
  finishTurn(agent, 15, 'aborted')
  notify(agent)
  assert.equal(inputs.length, 1)
  finishTurn(agent, 20)
  notify(agent)
  await settled()
  const updated = await read(agent)
  assert.equal(inputs.length, 2)
  // Evidence for known requirements (2, 7) plus messages since the last review; 10 is not resent.
  assert.deepEqual(sources(1), [2, 7, 15, 20])
  assert.deepEqual(payload(1).knownRequirements.map(item => item.source), [2, 7])
  assert.equal(updated.review.incremental, true)
  assert.notEqual(updated.review.id, first.review.id)
  assert.equal(updated.queued, null)
  assert.equal((await offer(agent)).messages.length, 1)

  finishTurn(agent, 30)
  notify(agent)
  await settled()
  assert.equal(inputs.length, 3)
  assert.deepEqual(sources(2), [2, 7, 30])

  const reread = await execute(agent, 'check')
  assert.deepEqual(sources(3), [2, 7, 10, 15, 20, 30])
  assert.equal(reread.review.incremental, false)
})

test('an automatic check is cancelled when the next turn starts and automatic review stays on', async () => {
  const agent = conversation()
  const model = assistantResult([])
  let requestSignal
  let calls = 0
  const { execute, listeners } = harness(agent, [], {
    async *stream(input) {
      calls++
      if (calls === 1) {
        yield* model.stream(input)
        return
      }
      requestSignal = input.signal
      await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }))
    },
  })
  finishTurn(agent, 10)
  await execute(agent, 'check')
  finishTurn(agent, 20)
  listeners.get('agent/status')({ agent, status: 'idle' })
  assert.equal((await execute(agent, 'status')).automatic.checking, true)
  agent.status = 'running'
  listeners.get('agent/status')({ agent, status: 'running' })
  assert.equal(requestSignal.aborted, true)
  await new Promise(resolve => setImmediate(resolve))
  const state = await execute(agent, 'status', { includeReview: true })
  assert.equal(state.automatic.enabled, true)
  assert.equal(state.automatic.checking, false)
  assert.equal(state.queued, null)
})

test('the saved profile interval controls the periodic prompt and later restarts its count', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'context-review-settings-'))
  t.after(() => {
    rmSync(join(dir, 'dsh-context-review.settings.json'), { force: true })
    rmdirSync(dir)
  })
  const agent = conversation()
  const settings = { reminderTurns: 2, askOnFindings: false }
  const first = harness(agent, candidates, undefined, { dir })
  await assert.rejects(first.execute(agent, 'settings', { settings: { ...settings, reminderTurns: 0 } }), /1 to 99/)
  await first.execute(agent, 'settings', { settings })
  const { execute } = harness(agent, candidates, undefined, { dir })
  assert.deepEqual((await execute(agent, 'status')).settings, settings)
  await execute(agent, 'reminder', { enabled: true })
  finishTurn(agent, 10)
  assert.equal((await execute(agent, 'status')).prompt, null)
  finishTurn(agent, 20)
  const due = (await execute(agent, 'status')).prompt
  assert.deepEqual(due, { id: 'reminder:0:2', kind: 'reminder', turns: 2 })
  const dismissed = await execute(agent, 'answer-prompt', { promptId: due.id, answer: 'later' })
  assert.equal(dismissed.prompt, null)
  finishTurn(agent, 30)
  finishTurn(agent, 40)
  const next = (await execute(agent, 'status')).prompt
  assert.notEqual(next.id, due.id)
  const started = await execute(agent, 'answer-prompt', { promptId: next.id, answer: 'check' })
  assert.equal(started.automatic.checking, true)
  await new Promise(resolve => setImmediate(resolve))
  const checked = await execute(agent, 'status', { includeReview: true })
  assert.ok(checked.review)
  assert.equal(checked.prompt, null)
  assert.equal(checked.queued, null)
})

test('a proactive question needs a current finding and an explicit response before recovery', async () => {
  const proposals = [{ ...candidates[0], replySignal: 'possible-conflict', replyQuote: 'The updated plan.' }]
  const agent = conversation()
  const { other, execute, listeners, offer } = harness(agent, proposals)
  const read = session => execute(session, 'status', { includeReview: true })
  const settled = () => new Promise(resolve => setImmediate(resolve))
  const onIdle = () => listeners.get('agent/status')({ agent, status: 'idle' })
  finishTurn(agent, 10)
  assert.equal((await execute(agent, 'check')).prompt, null)
  finishTurn(agent, 20)
  onIdle()
  await settled()
  const { prompt, review } = await read(agent)
  assert.equal(prompt.kind, 'finding')
  assert.equal(prompt.candidate.quote, original)
  assert.equal(prompt.candidate.replySignal.quote, 'The updated plan.')
  assert.equal((await offer(agent)).messages.length, 1)
  assert.equal((await read(other)).prompt, null)
  await assert.rejects(execute(other, 'answer-prompt', { promptId: prompt.id, answer: 'restore' }), /changed/)

  finishTurn(agent, 30)
  await assert.rejects(execute(agent, 'answer-prompt', { promptId: review.id, answer: 'restore' }), /changed/)
  onIdle()
  await settled()
  const fresh = (await read(agent)).prompt
  const approved = await execute(agent, 'answer-prompt', { promptId: fresh.id, answer: 'restore' })
  assert.equal(approved.prompt, null)
  assert.match(approved.queued.text, /Keep Wednesday free/)
  assert.equal((await offer(agent)).messages.length, 2)
  assert.equal((await offer(other)).messages.length, 1)

  await execute(agent, 'cancel')
  finishTurn(agent, 40)
  onIdle()
  await settled()
  assert.equal((await read(agent)).prompt, null)
})

test('a retired requirement is announced in the next request, stays out of later prompts and a profile can turn off finding pop-ups', async () => {
  const proposals = [{ ...candidates[0], replySignal: 'possible-omission' }]
  const agent = conversation()
  const { execute, offer, listeners } = harness(agent, proposals)
  finishTurn(agent, 10)
  await execute(agent, 'check')
  finishTurn(agent, 15)
  listeners.get('agent/status')({ agent, status: 'idle' })
  await new Promise(resolve => setImmediate(resolve))
  const hidden = await execute(agent, 'settings', { settings: { reminderTurns: 5, askOnFindings: false } })
  assert.equal(hidden.prompt, null)
  const visible = await execute(agent, 'settings', { settings: { reminderTurns: 5, askOnFindings: true } })
  const result = await execute(agent, 'answer-prompt', { promptId: visible.prompt.id, answer: 'no-longer-applies' })
  assert.match(result.queued.text, /no longer apply/)
  assert.ok(result.queued.text.includes(proposals[0].text))
  assert.equal(result.prompt, null)
  const outgoing = (await offer(agent)).messages
  assert.match(outgoing.at(-1).content[0].text, /no longer apply/)
  await execute(agent, 'cancel')
  finishTurn(agent, 20)
  listeners.get('agent/status')({ agent, status: 'idle' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await execute(agent, 'status')).prompt, null)
})

test('retry uses the last request with confirmed context and preserves the transcript and queue', async () => {
  const agent = conversation()
  const priorReply = { role: 'assistant', content: text('The original reply.') }
  agent.events.push({ seq: 8, type: 'assistant/message', data: priorReply })
  agent.active.push(priorReply)
  const reviewModel = assistantResult(candidates)
  const modelInputs = []
  const llm = {
    async *stream(request) {
      modelInputs.push(request)
      if (request.messages[0].role === 'system') yield* reviewModel.stream(request)
      else {
        yield { type: 'block-end', block: { type: 'text', text: 'The revised reply.' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    },
  }
  const { execute } = harness(agent, candidates, llm)
  const { review } = await execute(agent, 'check')
  assert.equal(review.retryAvailable, true)
  const { queued, retry } = await execute(agent, 'retry', { reviewId: review.id, ids: ['1'] })
  assert.equal(queued, null)
  assert.equal(retry.text, 'The revised reply.')
  assert.equal(agent.active.at(-1), priorReply)
  const request = modelInputs[1]
  assert.equal(request.tools, undefined)
  assert.equal(request.messages[0].content[0].text, replacement)
  assert.match(request.messages[1].content[0].text, /Keep Wednesday free/)
  assert.equal(request.messages.length, 2)

  agent.active.push({ role: 'tool', content: text('Tool output') })
  assert.equal(retryInput(agent.session, historyForReview(agent.session)), null)
})

test('a long reply keeps its ending, where a verdict or file link usually sits', () => {
  const reply = 'Opening. ' + 'x'.repeat(20_000) + ' Overall verdict: plausible. [film_reports/a.txt]'
  const excerpt = replyExcerpt(reply)
  assert.ok(excerpt.startsWith('Opening.'))
  assert.ok(excerpt.endsWith('Overall verdict: plausible. [film_reports/a.txt]'))
  assert.ok(excerpt.includes(replyGap))
  assert.equal(replyExcerpt('short reply'), 'short reply')
})
