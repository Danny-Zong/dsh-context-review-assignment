export const scopeEvent = 'plugin:dsh-context-review/scope-decision'

export function messageText(message) {
  return (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
}

export function evidenceKey({ source, quote }) {
  return `${source}\n${quote}`
}

// A condition is the user's own phrase for when a temporary change applies, such as "for the next two films".
export function conditionText(value) {
  const text = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : ''
  return text && text.length <= 300 ? text : null
}

export function scopedDecision(candidate, decision) {
  const scope = candidate.scope
  if (!scope || scope.resolved) throw new Error('This change is no longer awaiting clarification.')
  if (decision?.action === 'keep') {
    return {
      key: evidenceKey(candidate), prior: scope.prior, proposed: { source: candidate.source, quote: candidate.quote },
      certainty: 'confirmed', action: 'keep', text: `Keep the original requirement: ${scope.prior.quote}\nSet aside this proposed change: ${candidate.quote}`,
    }
  }
  const condition = conditionText(decision?.condition)
  const replacement = typeof decision?.text === 'string' ? decision.text.trim() : ''
  if (decision?.action !== 'apply' || !condition || !replacement || replacement.length > 600) {
    throw new Error('Enter when the change applies and the confirmed wording.')
  }
  return {
    key: evidenceKey(candidate), prior: scope.prior, proposed: { source: candidate.source, quote: candidate.quote },
    certainty: 'confirmed', action: 'apply', condition, replacement,
    text: `When ${condition}: ${replacement}\nOtherwise keep the original requirement: ${scope.prior.quote}`,
  }
}

export function scopeDecisions(events) {
  const latest = new Map()
  for (const event of events) {
    if (event.type === scopeEvent) latest.set(evidenceKey(event.data.prior), event.data)
  }
  return [...latest.values()]
}

export function withScopeDecisions(candidates, decisions) {
  const seen = new Set()
  return candidates.flatMap(candidate => {
    const key = evidenceKey(candidate)
    const decision = decisions.find(item => item.key === key || evidenceKey(item.prior) === key)
    if (!decision) return [candidate]
    if (seen.has(decision.key)) return []
    seen.add(decision.key)
    return [{
      ...candidate, text: decision.text, status: 'active', scope: { ...candidate.scope, prior: decision.prior, resolved: decision },
    }]
  })
}

const normalize = text => text.replace(/\s+/gu, ' ').trim()

export function inspectRequest(options, candidates) {
  const messages = options.messages.map(message => ({ role: message.role, text: normalize(messageText(message)) }))
  if (typeof options.system === 'string') messages.unshift({ role: 'system', text: normalize(options.system) })
  return {
    model: options.model ?? '', messageCount: messages.length,
    requirements: candidates.map(item => {
      const phrase = normalize(item.scope?.resolved?.text ?? item.quote)
      const approved = item.approvedText && normalize(item.approvedText)
      const roles = [...new Set(messages.filter(message => message.text.includes(phrase)).map(message => message.role))]
      const approvedPresent = Boolean(approved && messages.some(message => message.role === 'user' && message.text.includes(approved)))
      return {
        id: item.id, text: item.text, quote: item.quote, roles,
        present: approvedPresent || roles.some(role => role === 'user' || role === 'system'), approvedPresent,
        canRestore: !item.scope || Boolean(item.scope.resolved),
      }
    }),
  }
}

export function lastReplyTurn(events) {
  let open
  let last
  for (const event of events) {
    if (event.type === 'turn/start') open = { boundary: event.seq - 1, users: [], reply: false, rebuilt: false }
    if (!open) continue
    if (event.type === 'user/message' && event.data.source.kind === 'user') open.users.push(event.data)
    if (event.type === 'user/message' && event.data.source.kind === 'dsh-context-review'
      && event.data.source.summary === 'Context Review rebuilt the prepared request') open.rebuilt = true
    if (event.type === 'assistant/message' && messageText(event.data.message)) open.reply = true
    if (event.type === 'turn/end') {
      if (open.users.length) last = { ...open, succeeded: event.data.reason?.kind === 'completed' && open.reply }
      if (open.rebuilt && last && event.data.reason?.kind === 'completed' && open.reply) last.succeeded = true
      open = null
    }
  }
  return last?.succeeded && last.boundary >= 0 && last.users.every(user => user.content.every(block => block.type === 'text')) ? last : null
}
