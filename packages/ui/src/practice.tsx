/**
 * A practice session in the panel: the picked propositions, the active
 * problem with a thinking field (each submission goes to the tutor, who
 * answers with a hint or a verdict in the chat), and concluded problems with
 * the tutor's committed solution.
 */
import { useState } from 'react'
import type { PracticeView, ProblemView } from '@hodos/core'
import { api, errorText } from './api.js'
import { InlineMarkdown, Markdown } from './markdown.js'

const OUTCOME: Readonly<Record<string, string>> = { solved: 'Solved', solvedWithHints: 'Solved with hints', movedOn: 'Moved on', surrendered: 'Surrendered', dismissed: 'Dismissed' }
const MODE: Readonly<Record<string, string>> = { recall: 'Recall', discrimination: 'Discrimination', composition: 'Composition' }

function ActiveProblem(props: { readonly problem: ProblemView; readonly onChange: () => void }): React.ReactElement {
  const p = props.problem
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const send = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await api.thinking(p.id, text)
      setText('')
      props.onChange()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const dismiss = async (): Promise<void> => {
    if (!window.confirm('Dismiss this problem? It ends without a verdict.')) return
    try {
      await api.dismiss(p.id)
      props.onChange()
    } catch (e) {
      setError(errorText(e))
    }
  }
  return (
    <section className="problem active" aria-labelledby={`p-${p.id}`}>
      <header className="question-head"><span className="role-badge">{MODE[p.mode] ?? p.mode}</span></header>
      <div id={`p-${p.id}`} className="question-prompt"><Markdown text={p.statement} /></div>
      {p.thinking.length > 0 && (
        <ol className="thinking-log" aria-label="Your thinking so far">
          {p.thinking.map(t => <li key={t.at}>{t.text}</li>)}
        </ol>
      )}
      <form onSubmit={e => { e.preventDefault(); void send() }}>
        <label className="field">
          <span>Your thinking: work in progress, a question, or your answer</span>
          <textarea value={text} onChange={e => setText(e.target.value)} rows={5} disabled={busy} />
        </label>
        {error !== null && <p className="error" role="alert">{error}</p>}
        <div className="controls">
          <button type="submit" className="primary" disabled={busy || text.trim() === ''}>Send to tutor</button>
          <button type="button" onClick={() => { void dismiss() }} disabled={busy}>Dismiss problem</button>
        </div>
      </form>
    </section>
  )
}

function ConcludedProblem(props: { readonly problem: ProblemView }): React.ReactElement {
  const p = props.problem
  const c = p.conclusion
  return (
    <details className={`problem concluded outcome-${c?.outcome ?? 'none'}`}>
      <summary>
        <span className="role-badge">{MODE[p.mode] ?? p.mode}</span>
        <span className="summary-text"><InlineMarkdown text={p.statement.split('\n')[0] ?? ''} /></span>
        <span className="outcome">{OUTCOME[c?.outcome ?? ''] ?? ''}</span>
      </summary>
      <div className="question-prompt"><Markdown text={p.statement} /></div>
      {c !== undefined && <p><strong>Verdict:</strong> {c.verdict}{c.rung === null ? '' : ` (hints up to ${c.rung})`}</p>}
      {p.modelSolution !== undefined && <div className="explanation"><strong>Solution:</strong><Markdown text={p.modelSolution} /></div>}
    </details>
  )
}

/** The practice-session view. */
export function PracticeSessionView(props: { readonly practice: PracticeView; readonly refresh: () => void }): React.ReactElement {
  const s = props.practice
  const [notice, setNotice] = useState<string | null>(null)
  const active = s.problems.find(p => p.status === 'active')
  const concluded = s.problems.filter(p => p.status === 'concluded')
  const next = async (): Promise<void> => {
    try {
      await api.nextProblem(s.id)
      setNotice('Asked your tutor for the next problem.')
    } catch (e) {
      setNotice(errorText(e))
    }
  }
  const close = async (): Promise<void> => {
    try {
      await api.closePractice(s.id)
      props.refresh()
    } catch (e) {
      setNotice(errorText(e))
    }
  }
  return (
    <div className="practice">
      <header className="session-head">
        <span className="phase-badge phase-practice">Practice</span>
        <h1>{s.title}</h1>
        <p className="muted">Work each problem in the thinking field. Your tutor answers with the smallest hint that helps, or a verdict, in the chat.</p>
      </header>
      {active !== undefined && <ActiveProblem key={active.id} problem={active} onChange={props.refresh} />}
      {active === undefined && s.status === 'active' && (
        <div className="waiting">
          <p>{concluded.length === 0 ? 'Your tutor is preparing the first problem.' : 'Ask your tutor about the last problem in the chat, or move on.'}</p>
          {concluded.length > 0 && <button type="button" className="primary" onClick={() => { void next() }}>Next problem</button>}
        </div>
      )}
      {s.targets.length > 0 && (
        <details className="card">
          <summary><h2>Practising</h2></summary>
          <ul>{s.targets.map(t => <li key={t.id}><strong>{t.name}:</strong> {t.statement}</li>)}</ul>
        </details>
      )}
      {concluded.length > 0 && (
        <section className="card" aria-labelledby="done-title">
          <h2 id="done-title">Done</h2>
          {concluded.toReversed().map(p => <ConcludedProblem key={p.id} problem={p} />)}
        </section>
      )}
      {notice !== null && <output className="notice">{notice}</output>}
      {s.status === 'active' && <div className="controls footer-controls"><button type="button" onClick={() => { void close() }}>Close practice</button></div>}
    </div>
  )
}
