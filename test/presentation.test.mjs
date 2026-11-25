import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const review = {
  id: 'review', model: 'offline', reviewedMessages: 2, totalMessages: 2,
  candidates: [
    { id: '1', topic: 'deliverable', text: 'Use a table.', source: 10, quote: 'Use a table.', status: 'active', wordingPresent: true },
    { id: '2', topic: 'constraint', text: 'Keep Wednesdays free.', source: 20, quote: 'Keep Wednesdays free.', status: 'uncertain', wordingPresent: false },
  ],
}

const settings = { reminderTurns: 5, askOnFindings: true }

function renderPanel(view, status = { contextReview: true, reminderEnabled: false, automatic: { enabled: false }, settings }, options = {}) {
  const slots = new Map()
  const states = options.header ? [] : [view, [], {}, '', false, '', '', Boolean(options.settingsOpen)]
  const react = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: { ...props, children: children.length === 1 ? children[0] : children }, children: children.flat() }
    },
    useEffect() {},
    useRef(value) { return { current: value } },
    useState(initial) { return [states.length ? states.shift() : initial, () => {}] },
    useSyncExternalStore() { return { ...status, review } },
  }
  const ctx = {
    effect: callback => [...callback()],
    remote: { $on: () => () => {} },
    sidebarRightTabs: { register() {} },
    slots: {
      inject: (_seat, register) => register(),
      register: ({ name }, component) => slots.set(name, component),
    },
  }
  runInNewContext(client, {
    window: { __ModuleLoader__: { load: ({ factory }) => factory(() => react).apply(ctx) } },
    document: { createElement: () => ({}), head: { append() {} } },
  })
  const slot = options.header ? 'conversation.session.header.actions' : 'sidebar.right.pane.tab'
  const root = slots.get(slot)({ sessionId: 'offline', useSession: select => select({ running: options.running }) })
  const nodes = []
  function visit(node) {
    if (!node || typeof node !== 'object') return
    if (typeof node.type === 'function') {
      visit(node.type(node.props))
    } else {
      nodes.push(node)
      node.children.forEach(visit)
    }
  }
  visit(root)
  return nodes
}

test('summary groups the same evidence by topic and reveals only one item at a time', () => {
  const items = renderPanel('items')
  const summary = renderPanel('summary')
  assert.equal(items.filter(node => node.type === 'article').length, 2)
  assert.equal(items.filter(node => node.type === 'select').length, 0)
  assert.equal(summary.filter(node => node.type === 'article').length, 1)
  assert.equal(summary.filter(node => node.type === 'option').length, 2)
  assert.deepEqual(summary.filter(node => node.type === 'h3').map(node => node.children[0]), ['Deliverables', 'Constraints'])
})

test('a legacy host keeps the reminder unavailable and explains how to load the current host', () => {
  const oldHost = renderPanel('items', { contextReview: true, reviewId: 'review', queued: null, result: null })
  const checkbox = oldHost.find(node => node.type === 'input' && node.props.type === 'checkbox')
  assert.equal(checkbox.props.disabled, true)
  assert.ok(oldHost.some(node => node.children.some(child => typeof child === 'string' && child.includes('Fully quit and reopen'))))
  assert.equal(oldHost.some(node => node.type === 'textarea'), false)

  const currentHost = renderPanel('items', { contextReview: true, reminderEnabled: true })
  const reminder = currentHost.find(node => node.type === 'input' && node.props.type === 'checkbox')
  assert.equal(reminder.props.disabled, false)
  assert.equal(reminder.props.checked, true)
})

test('Start review explains automatic checking, and an outdated host asks for a restart', () => {
  const current = { contextReview: true, reminderEnabled: false }
  const oldHost = renderPanel('items', current)
  assert.ok(oldHost.some(node => node.children.includes('Fully quit and reopen DeepSeek Harness to load the updated Context Review host.')))
  assert.ok(!oldHost.some(node => node.type === 'button' && node.children.some(child => /automatic review/u.test(child))))

  const idle = renderPanel('items', { ...current, automatic: { enabled: false, checking: false } })
  assert.ok(idle.some(node => node.type === 'button' && node.children.includes('Start review')))

  const enabled = renderPanel('items', { ...current, automatic: { enabled: true, checking: true } })
  assert.ok(enabled.some(node => node.children.includes('Automatic review is on. Each new turn is checked against the requirements found so far.')))
  assert.ok(enabled.some(node => node.children.includes('Automatically checking the latest reply…')))
})

test('the conversation header can show a concrete question with the evidence and no sidebar', () => {
  const candidate = { ...review.candidates[0], replySignal: { kind: 'possible-conflict', quote: 'I will use prose.' } }
  const status = { settings, prompt: { kind: 'finding', id: 'review', candidate } }
  const header = renderPanel('items', status, { header: true })
  assert.equal(header.find(node => node.type === 'dialog').props['aria-label'], 'Does this requirement still apply?')
  assert.deepEqual(header.filter(node => node.type === 'blockquote').map(node => node.children[0]), ['Use a table.', 'I will use prose.'])
  assert.ok(header.some(node => node.type === 'button' && node.children.includes('No longer applies')))
  assert.equal(renderPanel('items', status, { header: true, running: true }).some(node => node.type === 'dialog'), false)
})

test('periodic prompts and interval settings are available in separate dialogs', () => {
  const due = renderPanel('items', { prompt: { kind: 'reminder', id: 'reminder:0:3', turns: 3 } }, { header: true })
  assert.ok(due.some(node => node.type === 'p' && String(node.children[0]).startsWith('3 turns have passed')))
  assert.ok(due.some(node => node.type === 'button' && node.children.includes('Check now')))
  const openSettings = renderPanel('items', { settings: { ...settings, reminderTurns: 3 } }, { settingsOpen: true })
  assert.equal(openSettings.find(node => node.type === 'dialog').props['aria-label'], 'Context Review settings')
  const interval = openSettings.find(node => node.type === 'input' && node.props.type === 'number')
  assert.equal(interval.props.value, '3')
  assert.equal(interval.props.min, 1)
  assert.equal(interval.props.max, 99)
})

test('a held native request is actionable while generation is marked as running', () => {
  const preview = { id: 'native-request', model: 'offline', intact: true, messageCount: 8, requirements: [
    { id: '1', text: 'Keep Wednesdays free.', quote: 'Keep Wednesdays free.', present: false, roles: [], canRestore: true },
  ] }
  const nodes = renderPanel('items', { inspection: { enabled: true, pending: preview } }, { header: true, running: true })
  assert.equal(nodes.find(node => node.type === 'dialog').props['aria-label'], 'Review the prepared request')
  assert.ok(nodes.some(node => node.type === 'p' && node.children.includes('Wording absent from this assembled request')))
  assert.equal(nodes.find(node => node.type === 'button' && node.children.includes('Send this request')).props.disabled, false)
  assert.equal(nodes.find(node => node.type === 'button' && node.children.includes('Restore and review revised request')).props.disabled, true)
})

test('Context Review command events leave no rows in the chat while other commands still render', () => {
  const definitions = []
  const react = { Fragment: Symbol('Fragment'), createElement() {}, useEffect() {}, useRef: value => ({ current: value }), useState: value => [value, () => {}], useSyncExternalStore() {} }
  const ctx = {
    effect: callback => [...callback()],
    remote: { $on: () => () => {} },
    sidebarRightTabs: { register() {} },
    slots: { inject: (_seat, register) => register(), register() {} },
    uiConversation: { events: { register: definition => { definitions.push(definition); return () => {} } } },
  }
  runInNewContext(client, {
    window: { __ModuleLoader__: { load: ({ factory }) => factory(() => react).apply(ctx) } },
    document: { createElement: () => ({}), head: { append() {} } },
  })
  const [hidden] = definitions
  assert.equal(hidden.target, 'chat')
  assert.deepEqual({ ...hidden.match({ type: 'command/run', data: { commandId: 'a', name: 'context-review' } }) }, { id: 'a', role: 'start', exclusive: true })
  assert.equal(hidden.match({ type: 'command/done', data: { commandId: 'a', kind: 'error', text: 'The model did not finish.' } }).exclusive, true)
  assert.equal(hidden.match({ type: 'command/done', data: { commandId: 'b', kind: 'success', text: '{"contextReview":true}' } }).exclusive, true)
  assert.equal(hidden.match({ type: 'command/run', data: { commandId: 'c', name: 'compact' } }), null)
  assert.equal(hidden.match({ type: 'command/done', data: { commandId: 'c', kind: 'success', text: 'done' } }), null)
  assert.equal(hidden.buildViewNode({}), null)
})
