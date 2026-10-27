/**
 * A learning session in the panel: the goal and phase, the probe's
 * assessment, the live plan map, the open question and the answered ones.
 */
import { useState } from 'react'
import type { SessionView } from '@hodos/core'
import { api, errorText } from './api.js'
import { PlanMap } from './plan-map.js'
import { AnsweredQuestion, OpenQuestion, type InstalledRenderer } from './question.js'

const PHASE: Readonly<Record<string, { label: string; help: string }>> = {
  probe: { label: 'Probe', help: 'Your tutor is finding where your understanding ends. "I don\'t know" is a fine answer.' },
  plan: { label: 'Plan', help: 'Your tutor maps the way from what you know to your goal. Ask in the chat for changes.' },
  teach: { label: 'Teach', help: 'One step at a time: predict, learn, check. Talk to your tutor in the chat.' },
  closed: { label: 'Closed', help: 'This session is closed.' },
}

interface Props {
  readonly session: SessionView
  readonly renderers: ReadonlyMap<string, InstalledRenderer>
  readonly model: boolean
  readonly refresh: () => void
  readonly announce: (message: string) => void
}

/** The learning-session view. */
export function LearnView(props: Props): React.ReactElement {
  const s = props.session
  const [notice, setNotice] = useState<string | null>(null)
  const phase = PHASE[s.phase] ?? { label: s.phase, help: '' }
  const close = async (): Promise<void> => {
    if (!window.confirm('Close this learning session? You can still read it, but the tutor stops asking questions here.')) return
    try {
      await api.closeLearning(s.id)
      props.refresh()
    } catch (e) {
      setNotice(errorText(e))
    }
  }
  const extract = async (): Promise<void> => {
    try {
      await api.extract(s.id)
      setNotice('Updating your knowledge graph in the background; see the Knowledge graph tab.')
    } catch (e) {
      setNotice(errorText(e))
    }
  }
  return (
    <div className="learn">
      <header className="session-head">
        <span className={`phase-badge phase-${s.phase}`}>{phase.label}</span>
        <h1>{s.goal}</h1>
        <p className="muted">{phase.help}</p>
      </header>

      {s.openQuestion !== null && s.phase !== 'closed' && (
        <OpenQuestion key={s.openQuestion.id} question={s.openQuestion} renderers={props.renderers} onDone={props.refresh} announce={props.announce} />
      )}
      {s.openQuestion === null && s.phase !== 'closed' && <p className="waiting">Your tutor is writing in the chat. Questions appear here.</p>}

      {s.plan !== null && (
        <section className="card" aria-labelledby="plan-title">
          <h2 id="plan-title">Plan <span className="muted">v{s.plan.version}</span></h2>
          <PlanMap plan={s.plan} mastery={s.mastery} />
          <p className="legend"><span className="key current" /> current <span className="key visited" /> visited <span className="key upcoming" /> upcoming <span className="key mastery" /> mastery estimate from graded checks</p>
        </section>
      )}

      {s.assessment !== null && (
        <details className="card assessment" open={s.phase === 'plan'}>
          <summary><h2>Where you started</h2></summary>
          <ul>
            {s.assessment.strands.map(st => <li key={st.strand}><strong>{st.strand}:</strong> {st.assessment}</li>)}
          </ul>
          {s.assessment.summary !== undefined && <p>{s.assessment.summary}</p>}
        </details>
      )}

      {s.answered.length > 0 && (
        <section className="card" aria-labelledby="history-title">
          <h2 id="history-title">Answered</h2>
          {s.answered.toReversed().map(q => <AnsweredQuestion key={q.id} question={q} />)}
        </section>
      )}

      {notice !== null && <output className="notice">{notice}</output>}
      <div className="controls footer-controls">
        {props.model && <button type="button" onClick={() => { void extract() }}>Update knowledge graph</button>}
        {s.phase !== 'closed' && <button type="button" onClick={() => { void close() }}>Close session</button>}
      </div>
    </div>
  )
}
