import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { LlmAdapter } from '__LLM_MODULE__'

export const name = 'context-review-native-fixture'
export const inject = ['llm', 'commands', 'agents', 'sessions', 'sessionPersistence', 'sessionController']

const prior = 'Keep Wednesdays free.'
const missing = 'Keep Sundays free.'
const tentative = 'Wednesdays might be free in November.'
const nextQuestion = 'Build the final version of the plan.'
const recordType = 'plugin:dsh-context-review/scope-decision'
const text = value => [{ type: 'text', text: value }]
const userMessage = value => ({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: text(value) })
const words = message => message.content.map(block => block.text).filter(Boolean).join('\n')

class OfflineAdapter extends LlmAdapter {
  calls = []

  async listModels(provider) {
    return [{ provider, id: 'offline', name: 'Context Review offline fixture', inputModalities: ['text'] }]
  }

  async *stream(options) {
    const request = options.messages.map(words)
    let answer = 'Offline planning answer.'
    if (request[0]?.startsWith('Identify explicit task requirements')) {
      const input = JSON.parse(request[1])
      const earlier = input.userMessages.find(entry => entry.text.includes(prior))
      const recent = input.userMessages.find(entry => entry.text.includes(tentative))
      answer = JSON.stringify({ candidates: [
        { source: earlier.source, text: prior, quote: prior, status: 'active', topic: 'constraint' },
        { source: earlier.source, text: missing, quote: missing, status: 'active', topic: 'constraint' },
        { source: recent.source, text: tentative, quote: tentative, status: 'uncertain', topic: 'constraint', scopeProposal: {
          priorSource: earlier.source, priorQuote: prior, certainty: 'tentative', condition: 'for the November plan',
        } },
      ] })
    } else if (options.sessionId && !options.purpose) {
      this.calls.push({ id: options.sessionId, request, model: options.model })
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: answer }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export function apply(ctx) {
  const offline = new OfflineAdapter()
  ctx.llm.registerAdapter(['a2-offline'], offline)
  let started = false
  ctx.on('agent/status', ({ agent, status }) => {
    if (started || status !== 'idle' || agent.id !== 'context-review-native') return
    if (!agent.session.deriveMessages().some(message => words(message).includes(tentative))) return
    started = true
    void exercise(agent).then(() => process.stderr.write('CONTEXT_REVIEW_SMOKE_OK\n'),
      error => process.stderr.write(`CONTEXT_REVIEW_SMOKE_ERROR ${error.stack}\n`))
  })

  async function exercise(agent) {
    const signal = AbortSignal.timeout(14_000)
    async function command(op, args = {}) {
      const invocation = '/context-review ' + JSON.stringify({ op, ...args })
      const response = (await ctx.commands.execute(agent, invocation, [], signal)).result
      assert.equal(response.kind, 'success', `${op}: ${response.text}`)
      return JSON.parse(response.text)
    }
    async function waitFor(test) {
      while (!signal.aborted) {
        const value = await test()
        if (value) return value
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      throw new Error('Timed out waiting for the native Harness state.')
    }

    const initial = await command('check')
    const sunday = initial.review.candidates.find(item => item.quote === missing)
    const proposal = initial.review.candidates.find(item => item.scope)
    assert.ok(initial.review.branchAvailable, 'Native branch is available after a completed reply')
    const originalAnswers = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').length
    const branch = (await command('retry-branch', { reviewId: initial.review.id, ids: [sunday.id] })).branch
    assert.equal(branch.started, true)
    const child = ctx.agents.get(branch.sessionId)
    assert.ok(child)
    await child.whenIdle()
    const branchCall = offline.calls.find(call => call.id === branch.sessionId)
    assert.ok(branchCall?.request.some(value => value.includes(tentative)))
    assert.ok(branchCall.request.some(value => value.includes('reviewed and confirmed') && value.includes(missing)))
    assert.equal(branchCall.model, 'offline')
    assert.equal(child.session.header.parentSession, agent.id)
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').length, originalAnswers)

    const scoped = await command('scope-decision', { reviewId: initial.review.id, candidateId: proposal.id,
      decision: { action: 'apply', condition: 'for the November plan', text: 'Wednesdays are available.' },
    })
    assert.equal(scoped.scopes[0].condition, 'for the November plan')
    assert.ok(scoped.queued.text.includes(`Outside those dates keep the original requirement: ${prior}`))
    const saved = agent.session.snapshotEvents().find(event => event.type === recordType)
    assert.equal(saved?.ignorable, true)

    // Use the same native surface operation as compaction to make a known historical item absent.
    const earlier = agent.session.snapshotEvents().find(event => event.type === 'user/message' && words(event.data).includes(missing))
    agent.session.append('user/message', {
      ...userMessage('Continue planning with the earlier coursework requirements.'),
      source: { kind: name, form: 'notice', summary: 'Synthetic context checkpoint' },
    }, { surfaceOp: { op: 'replace', startSeq: earlier.seq, endSeq: earlier.seq }, sourceEventSeqs: [earlier.seq] })

    await command('inspection', { enabled: true })
    const before = offline.calls.filter(call => call.id === agent.id).length
    agent.followup(userMessage(nextQuestion))
    const held = await waitFor(async () => (await command('status')).inspection.pending)
    assert.equal(held.requirements.find(item => item.id === sunday.id)?.present, false)
    assert.equal(offline.calls.filter(call => call.id === agent.id).length, before)
    await command('answer-inspection', { id: held.id, answer: 'correct', reviewId: held.reviewId, ids: [sunday.id] })
    const rebuilt = await waitFor(async () => {
      const item = (await command('status')).inspection.pending
      return item?.id !== held.id ? item : null
    })
    assert.equal(rebuilt.intact, true)
    assert.equal(rebuilt.requirements.find(item => item.id === sunday.id)?.present, true)
    assert.equal(offline.calls.filter(call => call.id === agent.id).length, before)
    await command('answer-inspection', { id: rebuilt.id, answer: 'send' })
    await agent.whenIdle()
    const after = offline.calls.filter(call => call.id === agent.id)
    assert.equal(after.length, before + 1)
    assert.ok(after.at(-1).request.some(value => value.includes(missing)))
    assert.ok(after.at(-1).request.some(value => value.includes('When for the November plan:')))
    assert.equal(after.at(-1).request.filter(value => value.includes(nextQuestion)).length, 1)

    const itemized = (await command('study-start', { view: 'items' })).study
    const summary = (await command('study-start', { view: 'summary' })).study
    assert.equal(itemized.fixture.request, summary.fixture.request)
    assert.deepEqual(itemized.fixture.rows, summary.fixture.rows)
    const result = (await command('study-submit', {
      trialId: summary.id, marked: ['wed', 'daily'], restorations: { wed: 'Keep every Wednesday free.' }, workload: 4,
    })).study.result
    assert.deepEqual(result.hits, ['wed'])
    assert.deepEqual(result.misses, ['reserve'])
    assert.deepEqual(result.falseAlarms, ['daily'])
    assert.deepEqual(result.accurateRestorations, ['wed'])
    assert.equal(offline.calls.filter(call => call.id === agent.id).length, before + 1)

    agent.followup(userMessage('Discard this request before it reaches the model.'))
    const discard = await waitFor(async () => (await command('status')).inspection.pending)
    await command('answer-inspection', { id: discard.id, answer: 'cancel' })
    await agent.whenIdle()
    assert.equal((await command('status')).inspection.latest.outcome, 'cancelled')
    assert.equal(offline.calls.filter(call => call.id === agent.id).length, before + 1)
    await ctx.sessions.flush(agent.session)
    const stored = await ctx.sessionPersistence.open(agent.id, 'read')
    try {
      const persisted = await stored.read(saved.seq, 1)
      assert.equal(persisted.events[0]?.type, recordType)
      assert.equal(persisted.events[0].data.condition, 'for the November plan')
    } finally {
      await stored.close()
    }
  }
}
