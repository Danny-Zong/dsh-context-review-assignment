window.__ModuleLoader__.load({
  id: 'dsh-context-review',
  factory(require) {
    const { Fragment, createElement: h, useEffect, useRef, useState, useSyncExternalStore } = require('react')
    const plugin = 'dsh-context-review'
    const kind = 'context-review'
    const restartMessage = 'Fully quit and reopen DeepSeek Harness to load the updated Context Review host.'
    const emptyStatus = {}
    const labels = { active: 'Likely current', uncertain: 'Check applicability', superseded: 'Superseded' }
    const topics = { scope: 'Task scope', deliverable: 'Deliverables', process: 'Process', constraint: 'Constraints', other: 'Other requirements' }
    const css = `
      .dsh-cr { box-sizing: border-box; height: 100%; overflow: auto; padding: 14px; font: inherit; }
      .dsh-cr h2 { margin: 0 0 8px; font-size: 16px; }
      .dsh-cr h3 { margin: 12px 0 4px; font-size: 1em; }
      .dsh-cr p { margin: 6px 0; }
      .dsh-cr-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 10px 0; }
      .dsh-cr-button { border: 1px solid currentColor; border-radius: 5px; color: inherit; background: transparent; padding: 4px 8px; font: inherit; cursor: pointer; }
      .dsh-cr-button:disabled { opacity: .45; cursor: default; }
      .dsh-cr-button[aria-pressed="true"], .dsh-cr-primary { background: #283f69; border-color: #436497; color: #fff; }
      .dsh-cr-note { opacity: .76; font-size: .87em; }
      .dsh-cr-error { border-inline-start: 3px solid #b94436; padding-inline-start: 8px; }
      .dsh-cr-status { border: 1px solid #688e7280; border-radius: 6px; padding: 8px; margin: 8px 0; }
      .dsh-cr-flag { font-weight: 600; }
      .dsh-cr-overview { border-inline-start: 3px solid #628bd3; padding-inline-start: 10px; }
      .dsh-cr-source-picker, .dsh-cr-edit { box-sizing: border-box; display: block; width: 100%; margin: 5px 0; background: Canvas; color: CanvasText; font: inherit; }
      .dsh-cr-edit { resize: vertical; }
      .dsh-cr-preview { white-space: pre-wrap; overflow-wrap: anywhere; }
      .dsh-cr-dialog { box-sizing: border-box; width: min(540px, calc(100% - 48px)); max-height: calc(100vh - 72px); padding: 22px; overflow: auto; color: CanvasText; background: Canvas; border: 1px solid #80808080; border-radius: 12px; box-shadow: 0 12px 40px #0004; font: inherit; }
      .dsh-cr-dialog::backdrop { background: #0006; }
      .dsh-cr-dialog h2 { font-size: 1.1em; margin: 0 0 12px; }
      .dsh-cr-dialog p { margin: 8px 0; }
      .dsh-cr-dialog fieldset { border: 0; padding: 0; margin: 0 0 12px; }
      .dsh-cr-dialog legend { margin-bottom: 8px; font-weight: 600; }
      .dsh-cr-setting { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
      .dsh-cr-list { padding: 0; margin: 8px 0; list-style: none; }
      .dsh-cr-card { border: 1px solid #80808060; border-radius: 6px; margin: 6px 0; padding: 8px; }
      .dsh-cr-card label { display: flex; gap: 6px; align-items: baseline; }
      .dsh-cr-card details, .dsh-cr-status details { margin-top: 6px; }
      .dsh-cr-quote { white-space: pre-wrap; overflow-wrap: anywhere; margin: 6px 0 0; padding-inline-start: 8px; border-inline-start: 2px solid #80808060; font: inherit; }
      .dsh-cr-button:focus-visible, .dsh-cr summary:focus-visible, .dsh-cr input:focus-visible { outline: 2px solid #628bd3; outline-offset: 2px; }
    `

    function button(text, props = {}) {
      return h('button', { type: 'button', className: 'dsh-cr-button', ...props }, text)
    }

    function Dialog({ heading, onCancel, children }) {
      const ref = useRef(null)
      useEffect(() => {
        const dialog = ref.current
        dialog.showModal()
        return () => dialog.close()
      }, [])
      return h('dialog', {
        ref, className: 'dsh-cr-dialog', 'aria-label': heading,
        onCancel: event => { event.preventDefault(); onCancel() },
      }, h('h2', null, heading), children)
    }

    function SettingsDialog({ settings, onSave, onClose }) {
      const [turns, setTurns] = useState(String(settings.reminderTurns))
      const [askOnFindings, setAsk] = useState(settings.askOnFindings)
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState('')

      async function save(event) {
        event.preventDefault()
        setError('')
        setSaving(true)
        try {
          await onSave({ reminderTurns: Number(turns), askOnFindings })
          onClose()
        } catch (reason) {
          setError(reason.message || 'Could not save settings.')
          setSaving(false)
        }
      }

      return h(Dialog, { heading: 'Context Review settings', onCancel: () => { if (!saving) onClose() } },
        h('form', { onSubmit: event => void save(event) },
          h('fieldset', null, h('legend', null, 'Reminders'),
            h('label', { className: 'dsh-cr-setting' }, 'Remind after',
              h('input', { type: 'number', min: 1, max: 99, step: 1, required: true, value: turns, disabled: saving,
                onChange: event => setTurns(event.target.value) }), 'conversation turns'),
            h('label', { className: 'dsh-cr-setting' }, h('input', {
              type: 'checkbox', checked: askOnFindings, disabled: saving, onChange: event => setAsk(event.target.checked),
            }), 'Ask when automatic review flags a requirement')),
          error && h('p', { className: 'dsh-cr-error', role: 'alert' }, error),
          h('div', { className: 'dsh-cr-bar' },
            button('Cancel', { disabled: saving, onClick: onClose }),
            button(saving ? 'Saving…' : 'Save settings', { type: 'submit', disabled: saving, className: 'dsh-cr-button dsh-cr-primary' }))))
    }

    function ScopeControls({ candidate, onChoose, disabled }) {
      const scope = candidate.scope
      const [condition, setCondition] = useState(scope.condition ?? '')
      const [text, setText] = useState('')
      return h('section', { className: 'dsh-cr-status', 'aria-label': 'Clarify the proposed change' },
        h('p', null, `Earlier requirement · event #${scope.prior.source}`),
        h('blockquote', { className: 'dsh-cr-quote' }, scope.prior.quote),
        h('p', null, `Proposed change · ${scope.certainty}`),
        h('blockquote', { className: 'dsh-cr-quote' }, candidate.quote),
        h('label', null, 'When does this change apply?', h('input', {
          className: 'dsh-cr-edit', value: condition, maxLength: 300, disabled, placeholder: 'For example: for the next two films',
          onChange: event => setCondition(event.target.value),
        })),
        h('label', null, 'Confirmed wording while it applies', h('textarea', {
          className: 'dsh-cr-edit', rows: 2, maxLength: 600, value: text, disabled, onChange: event => setText(event.target.value),
        })),
        h('div', { className: 'dsh-cr-bar' },
          button('Keep the earlier requirement', { disabled, onClick: () => void onChoose({ action: 'keep' }) }),
          button('Confirm change · add to next request', {
            disabled: disabled || !condition.trim() || !text.trim(),
            onClick: () => void onChoose({ action: 'apply', condition, text }),
          })))
    }

    function RequestCoverage({ preview, selected, onToggle }) {
      return h(Fragment, null,
        h('p', null, `${preview.model || 'Current model'} · ${preview.messageCount} assembled messages`),
        preview.restored > 0 && h('p', null, `${preview.restored} approved requirement(s) in this request.`),
        !preview.intact && h('p', { className: 'dsh-cr-error' }, 'Part of the original input is missing from this request.'),
        preview.requirements.length === 0 && h('p', null, 'Run a context review to check earlier requirements against the next request.'),
        h('ul', { className: 'dsh-cr-list' }, preview.requirements.map(item => h('li', { key: item.id, className: 'dsh-cr-card' },
          h('p', null, item.text), h('p', { className: 'dsh-cr-note' }, item.approvedPresent ? 'Approved wording found in the prepared request' : item.present ? `Wording found in ${item.roles.join(', ')}`
            : item.roles.length ? `Wording found only in ${item.roles.join(', ')}` : 'Wording absent from this assembled request'),
          h('details', null, h('summary', null, 'Original wording'), h('blockquote', { className: 'dsh-cr-quote' }, item.quote)),
          onToggle && !item.present && item.canRestore && h('label', null,
            h('input', { type: 'checkbox', checked: selected.includes(item.id), onChange: () => onToggle(item.id) }), 'Restore in a rebuilt request')))))
    }

    function PreparedRequest({ preview, onAnswer }) {
      const [selected, setSelected] = useState([])
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      async function answer(value) {
        if (busy) return
        setBusy(true)
        setError('')
        try { await onAnswer(value, selected) } catch (reason) { setError(reason.message); setBusy(false) }
      }
      return h(Dialog, { heading: 'Review the prepared request', onCancel: () => void answer('cancel') },
        h(RequestCoverage, { preview, selected, onToggle: id => setSelected(items => items.includes(id) ? items.filter(item => item !== id) : [...items, id]) }),
        error && h('p', { role: 'alert', className: 'dsh-cr-error' }, error),
        h('div', { className: 'dsh-cr-bar' },
          button('Cancel request', { autoFocus: true, disabled: busy, onClick: () => void answer('cancel') }),
          button('Restore and review revised request', { disabled: busy || !preview.intact || !selected.length, onClick: () => void answer('correct') }),
          button('Send this request', { className: 'dsh-cr-button dsh-cr-primary', disabled: busy || !preview.intact, onClick: () => void answer('send') })))
    }

    function ReviewPrompt({ prompt, onAnswer, onScope }) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const finding = prompt.kind === 'finding'
      const item = prompt.candidate
      if (prompt.kind === 'scope') {
        return h(Dialog, { heading: 'When should this change apply?', onCancel: () => void answer('later') },
          h(ScopeControls, { candidate: item, disabled: busy, onChoose: choice => answer(choice) }),
          error && h('p', { role: 'alert', className: 'dsh-cr-error' }, error),
          button('Not sure yet', { disabled: busy, onClick: () => void answer('later') }))
      }
      const heading = finding ? 'Does this requirement still apply?' : 'Check earlier requirements?'

      async function answer(value) {
        if (busy) return
        setError('')
        setBusy(true)
        try {
          if (typeof value === 'object') await onScope(value)
          else await onAnswer(value)
        } catch (reason) {
          setError(reason.message || 'Could not respond to Context Review.')
          setBusy(false)
        }
      }

      return h(Dialog, { heading, onCancel: () => void answer('later') },
        finding ? h(Fragment, null,
          h('p', { className: 'dsh-cr-flag' }, item.replySignal.kind === 'possible-conflict' ? 'Possible conflict in the latest reply' : 'Possible omission in the latest reply'),
          h('p', null, item.text),
          h('p', { className: 'dsh-cr-note' }, `Earlier wording · event #${item.source}`),
          h('blockquote', { className: 'dsh-cr-quote' }, item.quote),
          item.replySignal.quote && h(Fragment, null,
            h('p', { className: 'dsh-cr-note' }, 'Excerpt from the latest reply'),
            h('blockquote', { className: 'dsh-cr-quote' }, item.replySignal.quote)))
          : h('p', null, `${prompt.turns} turns have passed.`),
        error && h('p', { className: 'dsh-cr-error', role: 'alert' }, error),
        h('div', { className: 'dsh-cr-bar' },
          button('Later', { autoFocus: true, disabled: busy, onClick: () => void answer('later') }),
          finding && button('No longer applies', { disabled: busy, onClick: () => void answer('no-longer-applies') }),
          finding && button('Review in sidebar', { disabled: busy, onClick: () => void answer('review') }),
          button(finding ? 'Still applies · add to next request' : 'Check now', {
            className: 'dsh-cr-button dsh-cr-primary', disabled: busy, onClick: () => void answer(finding ? 'restore' : 'check'),
          })))
    }

    function Candidate({ candidate, selected, edit, onToggle, onEdit, onScope, disabled }) {
      const superseded = candidate.status === 'superseded'
      const unresolvedScope = candidate.scope && !candidate.scope.resolved
      return h('article', { className: 'dsh-cr-card' },
        h('label', null,
          !superseded && !unresolvedScope && h('input', {
            type: 'checkbox',
            disabled,
            checked: selected,
            onChange: onToggle,
            'aria-label': `Select for recovery: ${candidate.text}`,
          }),
          h('span', null, candidate.text)),
        h('p', { className: 'dsh-cr-note' }, labels[candidate.status], ' · ',
          candidate.wordingPresent ? 'Original wording in current model history' : 'Original wording not found in current model history'),
        candidate.replySignal && h('p', { className: 'dsh-cr-flag' },
          candidate.replySignal.kind === 'possible-conflict' ? 'Possible conflict in latest reply' : 'Possible omission in latest reply'),
        candidate.replySignal?.quote && h('details', null,
          h('summary', null, 'Excerpt from latest reply'),
          h('blockquote', { className: 'dsh-cr-quote' }, candidate.replySignal.quote)),
        h('details', null,
          h('summary', null, `Original wording · event #${candidate.source}`),
          h('blockquote', { className: 'dsh-cr-quote' }, candidate.quote)),
        candidate.replacement && h('details', null,
          h('summary', null, `Later change · event #${candidate.replacement.source}`),
          h('blockquote', { className: 'dsh-cr-quote' }, candidate.replacement.quote)),
        unresolvedScope && h('details', null, h('summary', null, 'Clarify when the change applies'),
          h(ScopeControls, { candidate, onChoose: onScope, disabled })),
        selected && !candidate.scope?.resolved && h('label', { style: { display: 'block', marginTop: 8 } }, 'Wording to restore',
          h('textarea', {
            className: 'dsh-cr-edit', rows: 2, maxLength: 600, disabled,
            value: edit ?? candidate.text, onChange: event => onEdit(event.target.value),
          })))
    }

    function Summary({ candidates, inspected, setInspected, renderCandidate }) {
      const groups = Object.entries(topics).map(([topic, title]) => ({ title, items: candidates.filter(item => item.topic === topic) }))
      const current = candidates.find(item => item.id === inspected) ?? candidates[0]
      const flagged = candidates.filter(item => item.replySignal).length
      const uncertain = candidates.filter(item => item.status === 'uncertain').length
      const superseded = candidates.filter(item => item.status === 'superseded').length
      return h('div', null,
        h('p', { className: 'dsh-cr-note' }, `${flagged} flagged in the latest reply · ${uncertain} uncertain · ${superseded} superseded`),
        h('div', { className: 'dsh-cr-overview', 'aria-label': 'Summary by topic' },
          groups.filter(group => group.items.length).map(group => h('section', { key: group.title },
            h('h3', null, group.title),
            h('p', null, group.items.map(item => {
              const text = item.text.replace(/[.!?。！？]$/u, '')
              return (item.status === 'active' ? text : `${text} (${labels[item.status].toLowerCase()})`) + '.'
            }).join(' '))))),
        h('details', null, h('summary', null, 'Inspect evidence and select requirements'),
          h('label', null, 'Requirement',
            h('select', { className: 'dsh-cr-source-picker', value: current.id, onChange: event => setInspected(event.target.value) },
              candidates.map(item => h('option', { key: item.id, value: item.id }, item.text)))),
          renderCandidate(current)))
    }

    function StudyTrial({ study, busy, onSubmit }) {
      const [marked, setMarked] = useState([])
      const [restorations, setRestorations] = useState({})
      const [rating, setRating] = useState('')
      const [inspected, setInspected] = useState('')
      const { fixture, result } = study
      const items = fixture.rows.map(item => ({
        ...item, status: 'active', topic: item.group === 'Schedule' ? 'constraint' : item.group === 'Process' ? 'process' : 'deliverable',
      }))
      function exportResult() {
        const url = URL.createObjectURL(new Blob([JSON.stringify({ trial: study.id, ...result }, null, 2)], { type: 'application/json' }))
        const link = document.createElement('a')
        link.href = url
        link.download = `context-review-${fixture.view}-${study.id}.json`
        link.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
      function itemControl(item) {
        const selected = marked.includes(item.id)
        return h('article', { className: 'dsh-cr-card', key: item.id },
          h('label', null, h('input', { type: 'checkbox', checked: selected, onChange: () => {
            setMarked(ids => selected ? ids.filter(id => id !== item.id) : [...ids, item.id])
          } }), `Mark missing · ${item.text}`),
          h('details', null, h('summary', null, `Earlier wording · event #${item.source}`), h('blockquote', { className: 'dsh-cr-quote' }, item.quote)),
          selected && h('label', null, 'Wording to restore', h('select', { className: 'dsh-cr-source-picker',
            value: restorations[item.id] ?? '', onChange: event => setRestorations(values => ({ ...values, [item.id]: event.target.value })),
          }, h('option', { value: '' }, 'Choose wording'), item.options.map(text => h('option', { key: text }, text)))))
      }
      if (result) return h('section', { className: 'dsh-cr-status', 'aria-label': 'Trial results' },
        h('p', null, `${result.hits.length} detected · ${result.misses.length} missed · ${result.falseAlarms.length} false alarms`),
        h('p', null, `${result.accurateRestorations.length} accurately restored · ${result.incorrectRestorations.length} incorrect · workload ${result.workload}/7`),
        h('details', null, h('summary', null, 'Assembled study request after your choices'), h('pre', { className: 'dsh-cr-quote' }, result.request)),
        button('Export trial result', { onClick: exportResult }))
      return h('section', null,
        h('h3', null, fixture.view === 'summary' ? 'Summary trial' : 'Itemized trial'),
        h('p', null, 'Mark missing requirements and choose wording to restore.'),
        h('pre', { className: 'dsh-cr-quote' }, fixture.request),
        fixture.view === 'summary' ? h(Summary, { candidates: items, inspected, setInspected, renderCandidate: itemControl })
          : h('div', null, items.map(itemControl)),
        h('label', { className: 'dsh-cr-setting' }, 'Perceived workload (1 low, 7 high)', h('select', {
          value: rating, onChange: event => setRating(event.target.value),
        }, h('option', { value: '' }, 'Rate workload'), [1, 2, 3, 4, 5, 6, 7].map(value => h('option', { key: value }, value)))),
        button('Record trial', { disabled: busy || !rating, onClick: () => void onSubmit({ trialId: study.id, marked, restorations, workload: Number(rating) }) }))
    }

    function ReviewPanel({ sessionId, runCommand, running, status, openBranch }) {
      const [view, setView] = useState('items')
      const review = status.review
      const [selected, setSelected] = useState([])
      const [edits, setEdits] = useState({})
      const [inspected, setInspected] = useState('')
      const [confirm, setConfirm] = useState(false)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [settingsOpen, setSettingsOpen] = useState(false)
      const operation = useRef(null)

      async function run(op, args = {}) {
        if (operation.current) return
        const controller = new AbortController()
        operation.current = controller
        setError('')
        setBusy(op)
        try {
          const latest = await runCommand(sessionId, { op, ...args }, controller.signal)
          if (controller.signal.aborted) return
          if (op === 'queue') clearSelection()
          if (op === 'retry') setConfirm(false)
          if (op === 'retry-branch' && latest.branch?.started) openBranch(latest.branch.sessionId)
        } catch (reason) {
          if (!controller.signal.aborted) setError(reason.message || 'Context review failed.')
        } finally {
          if (operation.current === controller) {
            operation.current = null
            if (!controller.signal.aborted) setBusy('')
          }
        }
      }

      useEffect(() => () => {
        operation.current?.abort()
        operation.current = null
      }, [sessionId])

      useEffect(() => {
        if (!running || !status.contextReview) void run('status', { includeReview: true })
      }, [running, sessionId])

      useEffect(clearSelection, [review?.id])

      function clearSelection() {
        setSelected([])
        setEdits({})
        setConfirm(false)
      }

      function toggle(id) {
        setSelected(items => items.includes(id) ? items.filter(item => item !== id) : [...items, id])
        setConfirm(false)
      }

      function cancelOperation() {
        operation.current?.abort()
        operation.current = null
        setBusy('')
      }

      // The renderer can reload from the project directory while the old host is still running.
      const hostReady = typeof status.reminderEnabled === 'boolean'
      const automatic = status.automatic
      const checking = busy === 'check' || automatic?.checking
      const locked = !hostReady || checking || Boolean(busy || running || status.queued)
      const selection = review?.candidates.filter(item => selected.includes(item.id)) ?? []
      const canConfirm = selection.length > 0 && selection.every(item => (edits[item.id] ?? item.text).trim())
      const recovery = {
        reviewId: review?.id, ids: selected,
        edits: Object.fromEntries(Object.entries(edits).filter(([id]) => selected.includes(id))),
      }

      function renderCandidate(item) {
        return h(Candidate, {
          key: item.id, candidate: item, selected: selected.includes(item.id), edit: edits[item.id], disabled: locked,
          onToggle: () => toggle(item.id), onEdit: text => {
            setEdits(current => ({ ...current, [item.id]: text }))
            setConfirm(false)
          },
          onScope: decision => run('scope-decision', { reviewId: review.id, candidateId: item.id, decision }),
        })
      }

      return h('section', { className: 'dsh-cr', 'aria-label': 'Context Review' },
        h('h2', null, 'Context Review'),
        h('div', { className: 'dsh-cr-bar' },
          button(checking ? 'Checking…' : automatic?.enabled ? 'Re-read whole conversation' : 'Start review', { disabled: !hostReady || Boolean(checking || busy || running), onClick: () => void run('check') }),
          button('Refresh status', { disabled: Boolean(busy), onClick: () => void run('status', { includeReview: true }) }),
          status.settings && button('Settings', { onClick: () => setSettingsOpen(true) }),
          ['check', 'retry'].includes(busy) && button('Stop', { onClick: cancelOperation })),
        settingsOpen && status.settings && h(SettingsDialog, {
          settings: status.settings, onClose: () => setSettingsOpen(false),
          onSave: settings => runCommand(sessionId, { op: 'settings', settings }),
        }),
        hostReady && h('div', { className: 'dsh-cr-status' },
          h('p', { role: 'status' }, !automatic
            ? 'Fully quit and reopen DeepSeek Harness to load the updated Context Review host.'
            : automatic.enabled
              ? 'Automatic review is on. Each new turn is checked against the requirements found so far.'
              : 'Start review reads the whole conversation once. After that, each new turn is checked automatically.'),
          automatic?.enabled && automatic.checking && !automatic.error && h('p', { role: 'status' }, 'Automatically checking the latest reply…'),
          automatic?.error && h('p', { className: 'dsh-cr-error', role: 'alert' }, automatic.error)),
        h('label', { className: 'dsh-cr-note' },
          h('input', { type: 'checkbox', checked: Boolean(status.reminderEnabled), disabled: !hostReady || Boolean(busy),
            onChange: event => void run('reminder', { enabled: event.target.checked }) }), ` Remind me every ${status.settings?.reminderTurns ?? 5} conversation turns`),
        status.inspection && h('p', null, h('label', null, h('input', {
          type: 'checkbox', checked: status.inspection.enabled, disabled: Boolean(busy || running),
          onChange: event => void run('inspection', { enabled: event.target.checked }),
        }), ' Review assembled requests before sending')),
        status.contextReview && !status.inspection && h('p', { className: 'dsh-cr-status', role: 'status' }, restartMessage),
        error && h('p', { className: 'dsh-cr-error', role: 'alert' }, error),
        status.inspection?.latest && h('details', { className: 'dsh-cr-status' },
          h('summary', null, `Last assembled request · ${status.inspection.latest.outcome}`), h(RequestCoverage, { preview: status.inspection.latest })),
        status.scopes?.length > 0 && h('details', { className: 'dsh-cr-status' }, h('summary', null, 'Confirmed scope decisions'),
          status.scopes.map(item => h('article', { key: item.key }, h('pre', { className: 'dsh-cr-quote' }, item.text),
            button('Queue this confirmed rule', { disabled: locked, onClick: () => void run('queue-scope', { key: item.key }) })))),
        status.branch && h('div', { className: 'dsh-cr-status' },
          h('p', { role: 'status' }, status.branch.started ? 'Retry started in the new branch.' : 'Retry branch created.'),
          button('Open retry branch', { onClick: () => openBranch(status.branch.sessionId) })),
        status.queued && h('div', { className: 'dsh-cr-status' },
          h('p', { role: 'status' }, `${status.queued.count} requirement(s) queued for your next message.`),
          h('details', null, h('summary', null, 'Preview the added context'),
            h('pre', { className: 'dsh-cr-quote' }, status.queued.text)),
          h('div', { className: 'dsh-cr-bar' },
            button('Cancel recovery', { disabled: Boolean(busy), onClick: () => void run('cancel') }))),
        status.result && h('p', { className: 'dsh-cr-status', role: 'status' },
          `${status.result.count} restored requirement(s) observed in the prepared model request.`),
        status.retry && h('details', { className: 'dsh-cr-status', open: true },
          h('summary', null, 'Retry preview'),
          h('div', { className: 'dsh-cr-preview' }, status.retry.text)),
        hostReady && review && h('div', null,
          h('p', { className: 'dsh-cr-note' },
            `${review.reviewedMessages} of ${review.totalMessages} text messages reviewed`,
            review.sampled ? ' · History sampled' : '',
            review.replyTruncated ? ' · Middle of latest reply omitted' : '',
            review.invalidCount ? ` · ${review.invalidCount} suggestions discarded` : ''),
          h('p', { className: 'dsh-cr-note' }, `Model · ${review.model}`),
          h('div', { className: 'dsh-cr-bar', 'aria-label': 'Display format' },
            button('Itemized', { 'aria-pressed': view === 'items', onClick: () => setView('items') }),
            button('Summary', { 'aria-pressed': view === 'summary', onClick: () => setView('summary') })),
          review.candidates.length === 0 && h('p', null, 'The model found no requirements with verifiable wording.'),
          review.candidates.length > 0 && (view === 'summary'
            ? h(Summary, { candidates: review.candidates, inspected, setInspected, renderCandidate })
            : h('ul', { className: 'dsh-cr-list', 'aria-label': 'Reviewed requirements' },
              review.candidates.map(item => h('li', { key: item.id }, renderCandidate(item))))),
          selected.length > 0 && h('div', { className: 'dsh-cr-status' },
            h('p', null, `${selected.length} selected for recovery`),
            !confirm && button('Preview recovery', { disabled: locked || !canConfirm, onClick: () => setConfirm(true) }),
            confirm && h('div', null,
              h('ul', null, selection.map(item => h('li', { key: item.id }, (edits[item.id] ?? item.text).trim()))),
              h('div', { className: 'dsh-cr-bar' },
                button('Add to next request', {
                  className: 'dsh-cr-button dsh-cr-primary', disabled: locked || !canConfirm,
                  onClick: () => void run('queue', recovery),
                }),
                review.retryAvailable && button(busy === 'retry' ? 'Retrying…' : 'Generate retry preview', {
                  disabled: locked || !canConfirm, onClick: () => void run('retry', recovery),
                }),
                review.branchAvailable && button(busy === 'retry-branch' ? 'Starting branch…' : 'Regenerate in a new Harness branch', {
                  disabled: locked || !canConfirm, onClick: () => void run('retry-branch', recovery),
                }),
                button('Back to editing', { disabled: locked, onClick: () => setConfirm(false) }))))),
        status.inspection && h('details', { className: 'dsh-cr-status' },
          h('summary', null, 'Controlled comparison'),
          h('div', { className: 'dsh-cr-bar' },
            button('Start Itemized trial', { disabled: Boolean(busy), onClick: () => void run('study-start', { view: 'items' }) }),
            button('Start Summary trial', { disabled: Boolean(busy), onClick: () => void run('study-start', { view: 'summary' }) })),
          status.study && h(StudyTrial, { key: status.study.id, study: status.study, busy: Boolean(busy), onSubmit: response => run('study-submit', response) })))
    }

    function apply(ctx) {
      const statuses = new Map()
      const statusListeners = new Set()

      function subscribeStatus(listener) {
        statusListeners.add(listener)
        return () => statusListeners.delete(listener)
      }

      function useStatus(sessionId) {
        return useSyncExternalStore(subscribeStatus, () => statuses.get(sessionId) ?? emptyStatus)
      }

      async function runCommand(sessionId, payload, signal) {
        const response = await ctx.remote.commands.execute(sessionId, '/context-review ' + JSON.stringify(payload), [], signal)
        if (!response.ok) throw new Error(response.error?.message || 'Could not reach the Harness host.')
        const result = response.value?.result
        if (result?.kind !== 'success') throw new Error(result?.text || 'The review plugin is unavailable.')
        const state = JSON.parse(result.text)
        if (!state.contextReview) throw new Error('The host returned an unexpected answer.')
        if (signal?.aborted) return state
        const previous = statuses.get(sessionId)?.review
        if (!state.review && previous && previous.id === state.reviewId) state.review = previous
        statuses.set(sessionId, state)
        statusListeners.forEach(listener => listener())
        return state
      }

      function HeaderButton({ sessionId, useSession }) {
        const readSession = useSession ?? (() => false)
        const running = readSession(state => state.running)
        const status = useStatus(sessionId)
        const [dismissed, setDismissed] = useState(null)
        const monitoring = Boolean(status.reminderEnabled || status.automatic?.enabled || status.automatic?.checking)
        const checking = Boolean(status.automatic?.checking)
        const inspecting = Boolean(status.inspection?.enabled || status.inspection?.pending)
        const prepared = status.inspection?.pending
        const promptKey = status.prompt && `${sessionId}:${status.prompt.id}`
        const prompt = running || dismissed === promptKey ? null : status.prompt

        useEffect(() => {
          if (running ? !inspecting : !monitoring && !inspecting) return
          const controller = new AbortController()
          let timer
          async function refresh() {
            try {
              const latest = await runCommand(sessionId, { op: 'status', includeReview: true }, controller.signal)
              const waitingForRequest = running && latest.inspection?.waiting && !latest.inspection?.pending
              if (!controller.signal.aborted && (latest.automatic?.checking || waitingForRequest)) {
                timer = setTimeout(refresh, waitingForRequest ? 700 : 1500)
              }
            } catch {
              // The sidebar's manual refresh remains available if the host disconnects.
            }
          }
          void refresh()
          return () => { controller.abort(); clearTimeout(timer) }
        }, [sessionId, monitoring, running, checking, inspecting, prepared?.id])

        async function respond(answer) {
          if (answer === 'later') setDismissed(promptKey)
          try {
            await runCommand(sessionId, { op: 'answer-prompt', promptId: prompt.id, answer })
          } catch (error) {
            if (answer === 'later') return
            await runCommand(sessionId, { op: 'status', includeReview: true }).catch(() => {})
            throw error
          }
          if (answer === 'check' || answer === 'review') ctx.sidebarRight.openTab(kind)
        }

        return h(Fragment, null,
          button(status.reminderDue ? 'Context Review · Check due' : 'Context Review', { onClick: () => ctx.sidebarRight.openTab(kind) }),
          prepared && h(PreparedRequest, {
            key: prepared.id, preview: prepared,
            onAnswer: (answer, ids) => runCommand(sessionId, { op: 'answer-inspection', id: prepared.id, reviewId: prepared.reviewId, answer, ids }),
          }),
          !prepared && prompt && h(ReviewPrompt, {
            key: promptKey, prompt, onAnswer: respond,
            onScope: decision => runCommand(sessionId, { op: 'scope-decision', reviewId: prompt.id, candidateId: prompt.candidate.id, decision }),
          }))
      }

      function SidebarBody({ sessionId, useSession }) {
        const readSession = useSession ?? (() => false)
        const running = readSession(state => state.running)
        return h(ReviewPanel, {
          key: sessionId, sessionId, runCommand, running, status: useStatus(sessionId),
          openBranch: branchId => ctx.get('uiWorkspace')?.openSession(branchId),
        })
      }

      // The sidebar talks to the host through /context-review commands. Harness logs every
      // command and Chat gives each one a row, so claim this plugin's command events and
      // build no node for them. Errors still reach the sidebar through runCommand.
      const ownCommandIds = new Set()
      const hiddenCommands = {
        kind: `${plugin}-command`,
        target: 'chat',
        match(event) {
          const data = event.data ?? {}
          if (event.type === 'command/run' && data.name === kind) {
            ownCommandIds.add(String(data.commandId))
            return { id: String(data.commandId), role: 'start', exclusive: true }
          }
          if (event.type === 'command/done' && (ownCommandIds.has(String(data.commandId))
            || (typeof data.text === 'string' && data.text.startsWith('{"contextReview":true')))) {
            return { id: String(data.commandId), role: 'update', exclusive: true }
          }
          return null
        },
        start: () => ({}),
        update: context => context.state ?? {},
        buildViewNode: () => null,
      }

      function CommandResult({ node }) {
        if (!node.outcome || node.outcome.text?.startsWith('{"contextReview":true')) return null
        return h('span', null, node.outcome.text || 'Context Review')
      }

      ctx.effect(function* () {
        const style = document.createElement('style')
        style.textContent = css
        document.head.append(style)
        yield () => style.remove()
        yield ctx.sidebarRightTabs.register({
          id: plugin,
          kind,
          title: () => 'Context Review',
        })
        yield ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab', key: plugin,
        }, SidebarBody))
        yield ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions', id: plugin, order: 500,
        }, HeaderButton))
        if (ctx.uiConversation) yield ctx.uiConversation.events.register(hiddenCommands)
        yield ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
          name: 'conversation.chat.commandview', key: kind,
        }, CommandResult))
      }, plugin)
    }

    return { name: plugin, inject: ['slots', 'sidebarRight', 'sidebarRightTabs', 'uiConversation', 'remote', 'remote.commands'], apply }
  },
})
