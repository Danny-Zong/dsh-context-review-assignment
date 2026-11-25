import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { historyForReview, retryInput, retryReply, reviewConversation } from './review.mjs'
import { evidenceKey, inspectRequest, lastReplyTurn, scopeEvent, scopedDecision, withScopeDecisions } from './context.mjs'
import { scoreTrial, studyFixture } from './study.mjs'

export const name = 'dsh-context-review'
export const inject = ['agents', 'commands', 'llm', 'profileContext']
const defaults = { reminderTurns: 5, askOnFindings: true }

function validateSettings(settings) {
  if (!Number.isInteger(settings?.reminderTurns) || settings.reminderTurns < 1 || settings.reminderTurns > 99) {
    throw new Error('Enter a reminder interval from 1 to 99 turns.')
  }
  if (typeof settings.askOnFindings !== 'boolean') throw new Error('Choose whether to show pop-ups for findings.')
  return { reminderTurns: settings.reminderTurns, askOnFindings: settings.askOnFindings }
}

function requireIdle(agent) {
  if (agent.status !== 'idle') throw new Error('Wait for the current turn to finish.')
}

function recoveryMessage(candidates) {
  const requirements = candidates.map(candidate => `- ${candidate.text}`)
  return {
    id: randomUUID(),
    role: 'user',
    source: { kind: name, form: 'notice', summary: 'Task requirements confirmed in Context Review' },
    content: [{
      type: 'text',
      text: ['The user reviewed and confirmed these earlier requirements for the current task:', ...requirements].join('\n'),
    }],
  }
}

function retirementMessage(candidates) {
  const requirements = candidates.map(candidate => `- ${candidate.text}`)
  return {
    id: randomUUID(),
    role: 'user',
    source: { kind: name, form: 'notice', summary: 'Task requirements retired in Context Review' },
    content: [{
      type: 'text',
      text: ['The user reviewed these earlier requirements and confirmed they no longer apply to the current task. Do not follow them from now on:', ...requirements].join('\n'),
    }],
  }
}

function approvedRequirements(review, revision, request) {
  if (!review || review.id !== request.reviewId || review.revision !== revision) {
    throw new Error('Review the latest conversation before restoring requirements.')
  }
  if (!Array.isArray(request.ids) || request.ids.length === 0 || request.ids.length > review.candidates.length) {
    throw new Error('Select at least one available requirement.')
  }
  const ids = new Set(request.ids)
  const selected = review.candidates.filter(item => ids.has(item.id) && item.status !== 'superseded')
  if (selected.length !== ids.size) throw new Error('One or more selected requirements are no longer available.')
  if (selected.some(item => item.scope && !item.scope.resolved)) throw new Error('Confirm the scope of the proposed change first.')

  const edits = request.edits ?? {}
  if (typeof edits !== 'object' || Array.isArray(edits) || Object.keys(edits).some(id => !ids.has(id))) {
    throw new Error('Edits must belong to selected requirements.')
  }
  return selected.map(item => {
    if (!Object.hasOwn(edits, item.id)) return item
    if (item.scope?.resolved) throw new Error('Use the scope decision to restore this conditional rule.')
    const text = typeof edits[item.id] === 'string' ? edits[item.id].trim() : ''
    if (!text || text.length > 600) throw new Error('Edited requirements must contain 1–600 characters.')
    return { ...item, text }
  })
}

export function apply(ctx) {
  const sessions = new WeakMap()
  const lifecycle = new AbortController()
  const settingsPath = ctx.profileContext?.dir && join(ctx.profileContext.dir, 'dsh-context-review.settings.json')
  let settings = defaults
  let sessionModule
  const sessionController = () => ctx.get?.('sessionController') ?? ctx.sessionController
  if (settingsPath) {
    try {
      settings = validateSettings({ ...defaults, ...JSON.parse(readFileSync(settingsPath, 'utf8')) })
    } catch {
      // Start with defaults when no valid preferences have been saved.
    }
  }

  function stateFor(session) {
    let state = sessions.get(session)
    if (!state) {
      state = {
        review: null, queued: null, result: null, retry: null, busy: false, reminderFrom: null,
        automatic: null, baseline: null, autoJob: null, reviewError: null, promptedReview: null, resolvedFindings: new Set(),
        inspect: false, waitingForInspection: false, watch: null, gate: null, corrected: null, latestRequest: null,
        branch: null, study: null,
      }
      sessions.set(session, state)
    }
    return state
  }

  function reminderDue(state, history) {
    return state.reminderFrom !== null && history.finishedTurns - state.reminderFrom >= settings.reminderTurns
  }

  function pendingPrompt(state, history, review) {
    if (state.busy) return null
    if (settings.askOnFindings && state.automatic && !state.queued && review?.proactive && review.id !== state.promptedReview) {
      const candidate = review.candidates.find(item => item.scope && !item.scope.resolved)
      if (candidate) return { id: review.id, kind: 'scope', candidate }
      const finding = review.candidates.find(item => item.replySignal && !state.resolvedFindings.has(evidenceKey(item)))
      if (finding) return { id: review.id, kind: 'finding', candidate: finding }
    }
    if (reminderDue(state, history)) {
      return { id: `reminder:${state.reminderFrom}:${settings.reminderTurns}`, kind: 'reminder', turns: settings.reminderTurns }
    }
    return null
  }

  function status(state, history, includeReview = false) {
    const review = state.review?.revision === history.revision ? state.review : null
    return {
      reviewId: review?.id ?? null,
      ...(includeReview && review ? { review } : {}),
      queued: state.queued ? { count: state.queued.count, text: state.queued.message.content[0].text } : null,
      result: state.result,
      retry: state.retry?.revision === history.revision ? state.retry : null,
      reminderEnabled: state.reminderFrom !== null,
      reminderDue: reminderDue(state, history),
      automatic: { enabled: state.automatic !== null, checking: Boolean(state.autoJob), error: state.reviewError },
      settings,
      prompt: pendingPrompt(state, history, review),
      scopes: history.scopes,
      inspection: { enabled: state.inspect, waiting: state.waitingForInspection, pending: state.gate?.preview ?? null, latest: state.latestRequest },
      branch: state.branch,
      study: state.study && { id: state.study.id, fixture: state.study.fixture, result: state.study.result },
    }
  }

  async function check(agent, state, history, signal, proactive = false) {
    // Only automatic turn checks are incremental; Start review always reads the whole conversation.
    const baseline = proactive ? state.baseline : null
    const review = await reviewConversation(agent, history, ctx.llm, signal, baseline)
    signal.throwIfAborted()
    requireIdle(agent)
    if (historyForReview(agent.session).revision !== history.revision) {
      throw new Error('The conversation changed while the review was running. Check it again.')
    }
    state.review = {
      id: randomUUID(), revision: history.revision, proactive, retryAvailable: Boolean(retryInput(agent.session, history)),
      branchAvailable: Boolean(sessionController()?.agents?.selectForNextRequest && lastReplyTurn(agent.session.snapshotEvents())), ...review,
    }
    state.reviewError = null
    state.baseline = { candidates: review.candidates, lastSource: Math.max(...history.sources.map(source => source.source)) }
    if (!proactive && state.reminderFrom !== null) state.reminderFrom = history.finishedTurns
    // A full review starts automatic checking, which then stays on for this conversation.
    state.automatic ??= { lastTurn: history.finishedTurns }
    state.automatic.lastTurn = history.finishedTurns
  }

  function startBackgroundReview(agent, state, history, proactive) {
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, lifecycle.signal])
    state.autoJob = controller
    state.busy = true
    state.reviewError = null
    void check(agent, state, history, signal, proactive).catch(error => {
      if (!signal.aborted) state.reviewError = error instanceof Error ? error.message : 'Context review failed.'
    }).finally(() => {
      state.autoJob = null
      state.busy = false
      scheduleAutomaticReview(agent, state)
    })
  }

  function scheduleAutomaticReview(agent, state) {
    const automatic = state?.automatic
    if (!automatic || state.busy || agent.status !== 'idle' || lifecycle.signal.aborted) return
    const history = historyForReview(agent.session)
    if (!history.completedHumanReply || !history.sources.length || history.finishedTurns <= automatic.lastTurn) return

    automatic.lastTurn = history.finishedTurns
    if (state.review?.revision === history.revision) return
    startBackgroundReview(agent, state, history, true)
  }

  async function execute(agent, request, signal) {
    const state = stateFor(agent.session)
    const history = historyForReview(agent.session)
    if (request.op === 'status') return status(state, history, request.includeReview === true)
    if (request.op === 'study-start' || request.op === 'study-submit') {
      signal.throwIfAborted()
      if (request.op === 'study-start') {
        state.study = { id: randomUUID(), fixture: studyFixture(request.view), started: Date.now(), result: null }
      } else {
        const trial = state.study
        if (!trial || trial.id !== request.trialId || trial.result) throw new Error('Start a new trial before submitting responses.')
        trial.result = scoreTrial(trial.fixture, request, Date.now() - trial.started)
      }
      return status(state, history, true)
    }
    if (request.op === 'inspection') {
      signal.throwIfAborted()
      state.inspect = request.enabled === true
      return status(state, history, true)
    }
    if (request.op === 'answer-inspection') {
      signal.throwIfAborted()
      const gate = state.gate
      if (!gate || gate.preview.id !== request.id || gate.answered) throw new Error('This prepared request is no longer held.')
      if (!['send', 'cancel', 'correct'].includes(request.answer)) throw new Error('Choose how to handle the prepared request.')
      if (request.answer === 'send' && !gate.preview.intact) throw new Error('The rebuilt request is missing part of the original turn.')
      let correction
      if (request.answer === 'correct') {
        const selected = approvedRequirements(gate.review, gate.review?.revision, request)
        if (!gate.preview.intact || selected.some(item => !gate.preview.requirements.some(row => row.id === item.id && !row.present))) {
          throw new Error('Select wording that is missing from this prepared request.')
        }
        const message = recoveryMessage(selected)
        message.source.summary = 'Context Review rebuilt the prepared request'
        const candidates = gate.review.candidates.map(item => selected.some(chosen => chosen.id === item.id)
          ? { ...item, approvedText: selected.find(chosen => chosen.id === item.id).text } : item)
        correction = { message, originalIds: gate.originalIds, review: { ...gate.review, candidates }, count: selected.length }
      }
      gate.answered = true
      state.gate = null
      if (request.answer === 'send') gate.release(true)
      else {
        state.latestRequest = { ...gate.preview, outcome: 'cancelled' }
        agent.cancel({ kind: 'user' }, { keepInbox: true })
        gate.release(false)
        if (correction) {
          state.waitingForInspection = true
          state.corrected = correction
          agent.followup(correction.message)
        }
      }
      return status(state, history, true)
    }
    if (request.op === 'settings') {
      signal.throwIfAborted()
      const next = validateSettings(request.settings)
      if (settingsPath) {
        const temporary = `${settingsPath}.${randomUUID()}.tmp`
        try {
          writeFileSync(temporary, JSON.stringify(next) + '\n', { flag: 'wx' })
          renameSync(temporary, settingsPath)
        } catch (error) {
          rmSync(temporary, { force: true })
          throw error
        }
      }
      settings = next
      return status(state, history)
    }
    if (request.op === 'reminder') {
      signal.throwIfAborted()
      state.reminderFrom = request.enabled === true ? history.finishedTurns : null
      return status(state, history)
    }
    requireIdle(agent)
    signal.throwIfAborted()

    if (request.op === 'queue-scope') {
      if (state.busy || state.queued) throw new Error('Finish the current review or cancel the queued recovery first.')
      const confirmed = history.scopes.find(item => item.key === request.key)
      if (!confirmed) throw new Error('This confirmed rule is no longer current.')
      state.queued = { count: 1, message: recoveryMessage([confirmed]), approved: [] }
      state.result = null
      return status(state, history, true)
    }

    if (request.op === 'scope-decision') {
      const review = state.review
      if (!review || review.id !== request.reviewId || review.revision !== history.revision) throw new Error('Review the latest conversation before deciding the scope.')
      if (state.busy || state.queued) throw new Error('Finish the current review or cancel the queued recovery first.')
      const candidate = review.candidates.find(item => item.id === request.candidateId)
      if (!candidate) throw new Error('The proposed rule could not be found.')
      const record = scopedDecision(candidate, request.decision)
      state.busy = true
      try {
        const resolve = createRequire(ctx.profileContext.installAnchor).resolve
        sessionModule ??= import(pathToFileURL(resolve('@deepseek-ai/dsh-session')).href)
        const { appendPluginRecord } = await sessionModule
        signal.throwIfAborted()
        requireIdle(agent)
        if (historyForReview(agent.session).revision !== history.revision) throw new Error('The conversation changed before the scope decision was saved.')
        appendPluginRecord(agent.session, scopeEvent, record)
      } finally {
        state.busy = false
      }
      const updated = historyForReview(agent.session)
      state.review = { ...review, id: randomUUID(), candidates: withScopeDecisions(review.candidates, updated.scopes), proactive: false }
      state.queued = { count: 1, message: recoveryMessage([record]), approved: [] }
      state.result = null
      state.promptedReview = review.id
      return status(state, updated, true)
    }

    if (request.op === 'answer-prompt') {
      const review = state.review?.revision === history.revision ? state.review : null
      const prompt = pendingPrompt(state, history, review)
      if (!prompt || prompt.id !== request.promptId) throw new Error('This prompt has changed. Refresh Context Review.')
      if (prompt.kind === 'reminder') {
        if (request.answer !== 'later' && request.answer !== 'check') throw new Error('Choose whether to check now or later.')
      } else {
        if (request.answer === 'restore') {
          const approved = approvedRequirements(review, history.revision, { reviewId: prompt.id, ids: [prompt.candidate.id] })
          state.queued = { count: 1, message: recoveryMessage(approved), approved }
          state.result = null
          state.resolvedFindings.add(evidenceKey(prompt.candidate))
        } else if (request.answer === 'no-longer-applies') {
          if (prompt.kind !== 'finding') throw new Error('Use the scope controls for this proposed change.')
          state.queued = { count: 1, message: retirementMessage([prompt.candidate]), approved: [] }
          state.result = null
          state.resolvedFindings.add(evidenceKey(prompt.candidate))
        } else if (request.answer !== 'later' && request.answer !== 'review') {
          throw new Error('Choose how to handle this requirement.')
        }
        state.promptedReview = review.id
      }
      if (reminderDue(state, history)) state.reminderFrom = history.finishedTurns
      if (prompt.kind === 'reminder' && request.answer === 'check' && !review) {
        startBackgroundReview(agent, state, history, false)
      }
      return status(state, history, true)
    }

    if (request.op === 'check') {
      if (state.busy) throw new Error('Context Review is already processing this conversation.')
      state.busy = true
      try {
        await check(agent, state, history, signal)
        return status(state, history, true)
      } finally {
        state.busy = false
        scheduleAutomaticReview(agent, state)
      }
    }
    if (request.op === 'cancel') {
      if (state.queued && agent.session.deriveMessages().some(message => message.id === state.queued.message.id)) {
        throw new Error('The recovery was already added to this conversation.')
      }
      state.queued = null
      state.result = null
      return status(state, history)
    }
    if (request.op === 'queue' || request.op === 'retry' || request.op === 'retry-branch') {
      if (state.busy) throw new Error('Wait for the current review or retry to finish.')
      if (state.queued) throw new Error('Cancel the queued recovery before selecting another.')
      const selected = approvedRequirements(state.review, history.revision, request)
      const message = recoveryMessage(selected)
      if (request.op === 'retry-branch') {
        const controller = sessionController()
        const turn = lastReplyTurn(agent.session.snapshotEvents())
        const header = agent.session.requestHeader()
        if (!controller?.agents?.selectForNextRequest || !turn || !header?.config) {
          throw new Error('Branch retry requires a completed turn with text requests and a native session controller.')
        }
        state.busy = true
        try {
          const { sessionId } = await controller.fork({ sessionId: agent.id, atSeq: turn.boundary })
          const child = ctx.agents.get(sessionId)
          state.branch = { sessionId, boundary: turn.boundary, started: false }
          signal.throwIfAborted()
          if (!child || historyForReview(agent.session).revision !== history.revision || agent.status !== 'idle') {
            throw new Error('The conversation changed. Open the new branch to continue manually.')
          }
          const { provider, model, reasoningEffort } = header.config
          controller.agents.selectForNextRequest(child, {
            provider, model, ...reasoningEffort && !header.adapterDefaults?.reasoningEffort ? { reasoningEffort } : {},
          })
          stateFor(child.session).queued = { count: selected.length, message, approved: selected }
          for (const user of turn.users) child.followup({ ...user, id: randomUUID(), source: { kind: 'user' } })
          state.branch.started = true
        } finally {
          state.busy = false
          scheduleAutomaticReview(agent, state)
        }
        return status(state, historyForReview(agent.session), true)
      }
      if (request.op === 'retry') {
        const messages = retryInput(agent.session, history)
        if (!messages) throw new Error('A retry preview requires a completed text-only reply and enough context budget.')
        state.busy = true
        try {
          const response = await retryReply(agent, messages, message, ctx.llm, signal)
          requireIdle(agent)
          if (historyForReview(agent.session).revision !== history.revision) {
            throw new Error('The conversation changed while the retry was running. Run the review again.')
          }
          state.retry = { text: response, revision: history.revision, count: selected.length }
          return status(state, history)
        } finally {
          state.busy = false
          scheduleAutomaticReview(agent, state)
        }
      }
      state.queued = { count: selected.length, message, approved: selected }
      state.result = null
      return status(state, history)
    }
    throw new Error('Unknown review action.')
  }

  ctx.effect(function* () {
    yield () => lifecycle.abort()
    yield ctx.commands.register({
      definitionId: name,
      name: 'context-review',
      description: 'Find and review earlier task requirements',
      input: { hint: 'Open Context Review beside the conversation title' },
      recordInput: false,
      async handler({ agent, rawInput, signal }) {
        if (!rawInput.trim()) return { kind: 'success', text: 'Open Context Review beside the conversation title.' }
        try {
          if (rawInput.length > 24_000) throw new Error('The review action is too long.')
          const result = await execute(agent, JSON.parse(rawInput), AbortSignal.any([signal, lifecycle.signal]))
          return { kind: 'success', text: JSON.stringify({ contextReview: true, ...result }) }
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : 'Context review failed.' }
        }
      },
    })

    yield ctx.on('agent/status', ({ agent, status: agentStatus }) => {
      const state = sessions.get(agent.session)
      if (state) state.waitingForInspection = agentStatus === 'running' && state.inspect
      if (agentStatus === 'running') state?.autoJob?.abort()
      if (agentStatus === 'idle') scheduleAutomaticReview(agent, state)
    })

    yield ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
      const decision = await next()
      const state = sessions.get(agent.session)
      if (!state || decision.kind !== 'enter') return decision
      const correction = state.corrected
      if (correction && decision.messages.some(message => message.id === correction.message.id)) {
        state.watch = { review: correction.review, originalIds: correction.originalIds, correction, hold: true }
        state.corrected = null
        return decision
      }
      if (!messages.some(message => message.source.kind === 'user')) return decision
      if (!decision.messages.some(message => message.source.kind === 'user')) return decision
      if (state.inspect || state.review) {
        const history = historyForReview(agent.session)
        const review = state.review?.revision === history.revision ? state.review : { id: randomUUID(), revision: history.revision, candidates: [] }
        const candidates = [...review.candidates]
        for (const [index, saved] of history.scopes.entries()) {
          if (!candidates.some(item => item.scope?.resolved?.key === saved.key)) {
            candidates.push({ id: `scope-${index + 1}`, text: saved.text, quote: saved.prior.quote, status: 'active',
              source: saved.prior.source, scope: { resolved: saved } })
          }
        }
        state.watch = {
          review: { ...review, candidates }, originalIds: decision.messages.filter(message => message.source.kind === 'user').map(message => message.id), hold: state.inspect,
        }
      }
      const queued = state.queued
      if (!queued) return decision
      if (agent.session.deriveMessages().some(message => message.id === queued.message.id)) return decision

      return { ...decision, messages: [...decision.messages, queued.message] }
    })

    yield ctx.on('llm/stream', (options, next) => {
      if (options.purpose) return next()
      const agent = options.sessionId && ctx.agents.get(options.sessionId)
      const state = agent && sessions.get(agent.session)
      if (!state) return next()
      const ids = new Set(options.messages.map(message => message.id))
      const queued = state.queued && ids.has(state.queued.message.id) ? state.queued : null
      const watch = state.watch
      state.watch = null
      state.waitingForInspection = false
      const finish = () => {
        const count = watch?.correction?.count ?? queued?.count
        if (count) state.result = { count, phase: 'prepared' }
        if (queued) {
          state.queued = null
          state.review = null
        }
      }
      if (!watch) {
        finish()
        return next()
      }
      const approved = new Map(queued?.approved?.map(item => [evidenceKey(item), item.text]))
      const requirements = watch.review?.candidates.filter(item => item.status !== 'superseded').map(item => ({
        ...item, approvedText: item.approvedText ?? approved.get(evidenceKey(item)),
      })) ?? []
      const intact = watch.originalIds.every(id => ids.has(id)) && (!watch.correction || ids.has(watch.correction.message.id))
      const preview = {
        id: randomUUID(), reviewId: watch.review?.id ?? null, intact,
        restored: watch.correction && ids.has(watch.correction.message.id) ? watch.correction.count : queued?.count ?? 0,
        ...inspectRequest(options, requirements),
      }
      if (!watch.hold) {
        state.latestRequest = { ...preview, outcome: 'released' }
        finish()
        return next()
      }

      const held = Promise.withResolvers()
      const signal = AbortSignal.any([options.signal ?? lifecycle.signal, lifecycle.signal])
      const gate = { preview, review: watch.review, originalIds: watch.originalIds, release: held.resolve, answered: false }
      state.gate = gate
      return (async function* () {
        const abort = () => held.resolve(false)
        signal.addEventListener('abort', abort, { once: true })
        const timer = setTimeout(() => {
          agent.cancel({ kind: 'hook', reason: 'Prepared request review timed out.' }, { keepInbox: true })
          held.resolve(false)
        }, 180_000)
        try {
          if (signal.aborted || !await held.promise) {
            state.latestRequest = { ...preview, outcome: 'cancelled' }
            if (queued && state.queued === queued) state.queued = null
            if (!options.signal?.aborted) agent.cancel({ kind: 'user' }, { keepInbox: true })
            return
          }
          options.signal?.throwIfAborted()
          state.latestRequest = { ...preview, outcome: 'released' }
          finish()
          yield* next()
        } finally {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          if (state.gate === gate) state.gate = null
        }
      })()
    })
  }, name)
}
