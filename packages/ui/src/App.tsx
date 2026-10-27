/**
 * The Hodos panel. In the "Hodos" sidebar tab it shows the chat's learning
 * or practice session (or a way to start one); in the "Knowledge graph" tab
 * (`?view=graph`) it shows the learner's graph.
 */
import { useState } from 'react'
import { api, currentChat, currentView, errorText, type WorkspaceState } from './api.js'
import { GraphView } from './graph.js'
import { LearnView } from './learn.js'
import { PracticeSessionView } from './practice.js'
import { useRenderers } from './question.js'
import { Polled, usePolled } from './store.js'

const stateResource = new Polled<WorkspaceState>(() => api.state(), 2500)

function Home(props: { readonly state: WorkspaceState; readonly refresh: () => void }): React.ReactElement {
  const s = props.state
  const [goal, setGoal] = useState('')
  const [topic, setTopic] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inChat = currentChat() !== ''
  const run = async (work: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await work()
      props.refresh()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="home">
      <header className="session-head">
        <h1>Hodos</h1>
        <p className="muted">Learn anything with a tutor that first finds out what you know, then teaches it one step at a time.</p>
      </header>
      {!inChat && <p className="notice">Open this panel from a chat to start a session there.</p>}
      <section className="card">
        <h2>Learn something</h2>
        <form onSubmit={e => { e.preventDefault(); void run(() => api.startLearning(goal)) }}>
          <label className="field"><span>What do you want to understand?</span><input value={goal} onChange={e => setGoal(e.target.value)} placeholder="e.g. why the chain rule works" disabled={!inChat || busy} /></label>
          <button type="submit" className="primary" disabled={!inChat || busy || goal.trim() === ''}>Start learning in this chat</button>
        </form>
      </section>
      <section className="card">
        <h2>Practise</h2>
        <p className="muted">Pick propositions in the Knowledge graph tab, or name a topic.</p>
        <form onSubmit={e => { e.preventDefault(); void run(() => api.startPractice([], topic)) }}>
          <label className="field"><span>Topic</span><input value={topic} onChange={e => setTopic(e.target.value)} disabled={!inChat || busy} /></label>
          <button type="submit" disabled={!inChat || busy || topic.trim() === ''}>Start practice in this chat</button>
        </form>
      </section>
      {error !== null && <p className="error" role="alert">{error}</p>}
      {s.reviews.length > 0 && (
        <section className="card">
          <h2>Due for review</h2>
          <ul>{s.reviews.map(r => <li key={`${r.sessionId}:${r.nodeId}`}><strong>{r.title}</strong> <span className="muted">from “{r.goal}”: open that chat and ask your tutor for a review</span></li>)}</ul>
        </section>
      )}
      {s.sessions.length > 0 && (
        <section className="card">
          <h2>Your learning sessions</h2>
          <ul>{s.sessions.map(x => <li key={x.id}>{x.goal} <span className="muted">({x.phase})</span></li>)}</ul>
        </section>
      )}
      {s.drafts.length > 0 && (
        <section className="card">
          <h2>Question banks to review</h2>
          <p className="muted">Courses proposed by a tutor or imported from the course inbox. Approved courses give your tutor verified exercises to ask.</p>
          <ul className="drafts">
            {s.drafts.map(d => (
              <li key={`${d.id}@${d.version}`}>
                <strong>{d.title}</strong> <span className="muted">{d.items} exercises · {d.origin === 'import' ? 'imported' : 'proposed by the tutor'} · not independently verified</span>
                <span className="controls">
                  <button type="button" onClick={() => { void run(() => api.decideDraft(d.id, d.version, true)) }} disabled={busy}>Approve</button>
                  <button type="button" onClick={() => { void run(() => api.decideDraft(d.id, d.version, false)) }} disabled={busy}>Reject</button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/** The panel. */
export function App(): React.ReactElement {
  const snap = usePolled(stateResource)
  const renderers = useRenderers()
  const [announcement, setAnnouncement] = useState('')
  const refresh = (): void => { void stateResource.refresh() }
  const state = snap.data
  const view = currentView()
  let body: React.ReactElement
  if (state === null) body = <p className="muted">{snap.error ?? 'Loading…'}</p>
  else if (view === 'graph') body = <GraphView model={state.model} chatIsSession={state.binding !== null} />
  else if (state.learn !== null) body = <LearnView session={state.learn} renderers={renderers} model={state.model} refresh={refresh} announce={setAnnouncement} />
  else if (state.practice !== null) body = <PracticeSessionView practice={state.practice} refresh={refresh} />
  else body = <Home state={state} refresh={refresh} />
  return (
    <main className={`app view-${view}`}>
      {snap.error !== null && state !== null && <p className="error" role="alert">{snap.error}</p>}
      {body}
      <p className="sr-only" aria-live="polite">{announcement}</p>
    </main>
  )
}
