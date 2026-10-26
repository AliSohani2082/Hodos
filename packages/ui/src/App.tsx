/**
 * The Hodos learning workspace: a tutor pane (lesson, guidance, results), an
 * environment pane (the exercise) and a path footer. The current mode —
 * diagnostic, teach, practice, checkpoint, review — is always visible.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AttemptView, CheckpointView, ExerciseView, JourneyView, LessonView, SkillView } from '@hodos/core'
import { api, ApiError, currentSession, type CatalogEntry, type DraftEntry, type WorkspaceState } from './api.js'
import { ExercisePanel } from './exercise.js'
import { LessonPanel } from './lesson.js'

const POLL_MS = 4000

type Mode = 'start' | 'diagnostic' | 'planning' | 'teach' | 'practice' | 'checkpoint' | 'remedial' | 'review' | 'rest' | 'complete'

const MODE_TEXT: Readonly<Record<Mode, { label: string; help: string }>> = {
  start: { label: 'Welcome', help: 'Pick a course or describe what you want to learn.' },
  diagnostic: { label: 'Placement', help: 'A few questions find where to start. "I don\'t know" is a fine answer.' },
  planning: { label: 'Your path', help: 'Review the skills Hodos proposes, then start.' },
  teach: { label: 'Teach', help: 'Read the lesson and answer its check questions.' },
  practice: { label: 'Practice', help: 'Practise with hints and feedback. Your tutor can help.' },
  checkpoint: { label: 'Checkpoint', help: 'On your own: no hints, no tutor help. Results at the end.' },
  remedial: { label: 'Revisit', help: 'A short step on what the checkpoint showed, then more practice.' },
  review: { label: 'Review', help: 'Spaced review keeps mastered skills fresh.' },
  rest: { label: 'Break', help: 'You have worked hard on this skill today.' },
  complete: { label: 'Goal reached', help: 'Reviews will be scheduled to keep it fresh.' },
}

function modeOf(journey: JourneyView | null): Mode {
  if (journey === null) return 'start'
  switch (journey.nextAction.type) {
    case 'diagnostic': return 'diagnostic'
    case 'approve-path': return 'planning'
    case 'lesson': return 'teach'
    case 'practice': return 'practice'
    case 'checkpoint': return 'checkpoint'
    case 'remedial': return 'remedial'
    case 'review': return journey.phase === 'reviewing' ? 'review' : journey.phase === 'complete' ? 'complete' : 'practice'
    case 'rest': return 'rest'
    case 'complete': return 'complete'
  }
}

function StartPanel(props: { catalog: readonly CatalogEntry[]; onStart: (goal: string, courseId?: string, skipDiagnostic?: boolean) => void; busy: boolean }): React.ReactElement {
  const [goal, setGoal] = useState('')
  return (
    <section className="start" aria-labelledby="start-title">
      <h2 id="start-title">What do you want to learn?</h2>
      <form onSubmit={e => { e.preventDefault(); if (goal.trim() !== '') props.onStart(goal.trim()) }}>
        <label className="field">
          <span>Your goal</span>
          <input value={goal} onChange={e => setGoal(e.target.value)} placeholder="e.g. Teach me chess tactics: knight forks" />
        </label>
        <button type="submit" disabled={props.busy || goal.trim() === ''}>Start</button>
      </form>
      {props.catalog.length > 0 && <h3>Installed courses</h3>}
      <ul className="catalog">
        {props.catalog.map(c => (
          <li key={c.id}>
            <h4>{c.title}</h4>
            <p>{c.description}</p>
            {!c.available && <p className="warning">Its environment is not installed.</p>}
            <button type="button" disabled={props.busy || !c.available} onClick={() => props.onStart(c.title, c.id)}>Start “{c.title}”</button>
          </li>
        ))}
      </ul>
      <p className="hint-text">You can also tell your tutor in the chat what you want to learn.</p>
    </section>
  )
}

function PathFooter(props: { journey: JourneyView }): React.ReactElement {
  const { journey } = props
  return (
    <footer className="path" aria-label="Learning path">
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={journey.progress.percent} aria-label="Skills mastered">
        <div className="progress-fill" style={{ width: `${journey.progress.percent}%` }} />
      </div>
      <ol className="skills">
        {journey.path.map(s => <SkillChip key={s.id} skill={s} />)}
        {journey.diagnosedKnown.map(id => <li key={id} className="skill status-known" title="Placed out by the diagnostic">{id} · known</li>)}
      </ol>
      <span className="summary">{journey.progress.mastered}/{journey.progress.total} mastered{journey.dueReviews > 0 ? ` · ${journey.dueReviews} due for review` : ''}</span>
    </footer>
  )
}

function SkillChip(props: { skill: SkillView }): React.ReactElement {
  const s = props.skill
  return (
    <li className={`skill status-${s.status}`} title={s.unmet.join('\n') || undefined}>
      <span className="skill-title">{s.title}</span>
      <span className="skill-status">{s.status === 'review-due' ? 'review due' : s.status}{s.status === 'active' ? ` · ${Math.round(s.pMastered * 100)}%` : ''}</span>
    </li>
  )
}

function CheckpointResult(props: { checkpoint: CheckpointView }): React.ReactElement | null {
  const r = props.checkpoint.result
  if (r === undefined) return null
  return (
    <section className={`checkpoint-result ${r.passed ? 'passed' : 'failed'}`} aria-label="Checkpoint result">
      <h3>{r.passed ? 'Checkpoint passed' : 'Not yet — let\'s revisit'}</h3>
      <p>{r.correct} of {props.checkpoint.total} correct.</p>
      {!r.passed && r.unmet.length > 0 && <ul>{r.unmet.map(u => <li key={u}>{u}</li>)}</ul>}
      {r.items.length > 0 && (
        <ol>{r.items.map(i => <li key={i.itemId}>{i.correct ? '✓' : '✗'} {i.explanation}</li>)}</ol>
      )}
      {r.adaptation?.insertedPrerequisites.length !== undefined && r.adaptation.insertedPrerequisites.length > 0 && <p>First, a refresher: {r.adaptation.insertedPrerequisites.join(', ')}.</p>}
    </section>
  )
}

function Drafts(props: { drafts: readonly DraftEntry[]; onDecide: (d: DraftEntry, approve: boolean) => void }): React.ReactElement | null {
  if (props.drafts.length === 0) return null
  return (
    <section className="drafts" aria-label="Proposed courses">
      <h2>Proposed courses</h2>
      <p className="provenance">Written by your tutor or a subagent. Hodos checked their structure; their content is not independently verified.</p>
      {props.drafts.map(d => (
        <article key={`${d.id}@${d.version}`}>
          <h3>{d.title} <small>{d.id}@{d.version}</small></h3>
          <p>{d.description}</p>
          <ol>{d.skills.map(s => <li key={s.id}>{s.title} <small>({s.kind}{s.requires.length > 0 ? `; after ${s.requires.join(', ')}` : ''})</small></li>)}</ol>
          <p>{d.lessons} lesson(s), {d.items} exercise(s).</p>
          <button type="button" onClick={() => props.onDecide(d, true)}>Approve</button>
          <button type="button" className="secondary" onClick={() => props.onDecide(d, false)}>Reject</button>
        </article>
      ))}
    </section>
  )
}

/** The workspace. */
export function App(): React.ReactElement {
  const [state, setState] = useState<WorkspaceState | null>(null)
  const [lesson, setLesson] = useState<LessonView | null>(null)
  const [lastAttempt, setLastAttempt] = useState<AttemptView | null>(null)
  // The exercise on screen: kept after it is finished so its feedback stays until "Next".
  const [current, setCurrent] = useState<ExerciseView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const loading = useRef(false)

  const refresh = useCallback(async (): Promise<WorkspaceState | null> => {
    if (loading.current) return null
    loading.current = true
    try {
      const next = await api.state()
      setState(next)
      return next
    } catch (e) {
      setError(e instanceof ApiError ? (e.code === 'UNAUTHORIZED' ? 'Your DeepSeek Harness session has expired; reload the page.' : e.message) : 'Hodos is not reachable.')
      return null
    } finally {
      loading.current = false
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { if (!document.hidden) void refresh() }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [refresh])

  const mode = modeOf(state?.journey ?? null)
  const journey = state?.journey ?? null

  useEffect(() => {
    const open = state?.exercise ?? null
    setCurrent(previous => open ?? (previous !== null && lastAttempt !== null && lastAttempt.presentationId === previous.id ? previous : null))
  }, [state, lastAttempt])

  // Lessons load when the stage needs one.
  useEffect(() => {
    if (mode !== 'teach' && mode !== 'remedial') { setLesson(null); return }
    api.lesson().then(setLesson).catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not load the lesson.'))
  }, [mode, journey?.activeSkill?.id])

  // An exercise stage without an open exercise asks for the next one.
  useEffect(() => {
    if (state === null || busy) return
    const needsExercise = mode === 'diagnostic' || mode === 'practice' || mode === 'checkpoint' || mode === 'review' || mode === 'remedial'
    if (!needsExercise || state.exercise !== null || mode === 'remedial') return
    if (lastAttempt !== null && lastAttempt.status !== 'continue' && lastAttempt.canRetry === false && mode === 'practice') return
    setBusy(true)
    api.nextExercise().then(() => refresh()).catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not load the next exercise.')).finally(() => setBusy(false))
  }, [state, mode, busy, lastAttempt, refresh])

  const act = async (work: () => Promise<unknown>, success?: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await work()
      if (success !== undefined) setAnnouncement(success)
      setLastAttempt(null)
      await refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  const banner = MODE_TEXT[mode]
  const exercise = current
  const showExercise = exercise !== null && (mode === 'diagnostic' || mode === 'practice' || mode === 'checkpoint' || mode === 'review')
  const readyForCheckpoint = journey?.nextAction.type === 'practice' && journey.nextAction.readyForCheckpoint

  return (
    <div className={`workspace mode-${mode}`}>
      <a className="skip-link" href="#main">Skip to the exercise</a>
      <header className="top">
        <div className={`mode-banner mode-${mode}`} role="status" aria-live="polite">
          <strong>{banner.label}</strong>
          <span>{banner.help}</span>
        </div>
        {journey !== null && <h1 className="goal">{journey.course.title}<small> — {journey.goalText}</small></h1>}
        {currentSession() === '' && <p className="warning">Open Hodos from a DeepSeek Harness session so your tutor can follow along.</p>}
      </header>
      {error !== null && <p className="error" role="alert">{error} <button type="button" className="link" onClick={() => setError(null)}>Dismiss</button></p>}
      <p className="sr-only" aria-live="polite">{announcement}</p>
      <main id="main" className="panes">
        <section className="tutor-pane" aria-label="Tutor">
          {state === null && <p>Loading…</p>}
          {state !== null && journey === null && <StartPanel catalog={state.catalog} busy={busy} onStart={(goal, courseId) => { void act(() => api.start(goal, courseId === undefined ? {} : { courseId }), 'Journey started.') }} />}
          {state !== null && <Drafts drafts={state.drafts} onDecide={(d, approve) => { void act(() => api.decideDraft(d.id, d.version, approve), approve ? 'Course approved.' : 'Course rejected.') }} />}
          {journey !== null && mode === 'planning' && (
            <section className="plan" aria-labelledby="plan-title">
              <h2 id="plan-title">Your path</h2>
              {journey.diagnosedKnown.length > 0 && <p>You already know: {journey.diagnosedKnown.join(', ')}.</p>}
              <ol>{journey.path.map(s => <li key={s.id}>{s.title}</li>)}</ol>
              <button type="button" disabled={busy} onClick={() => { void act(() => api.approvePath(), 'Path approved.') }}>Start this path</button>
            </section>
          )}
          {journey !== null && mode === 'diagnostic' && (
            <p>Answer what you can — this only decides where you start. <button type="button" className="link" disabled={busy} onClick={() => { void act(() => api.skipDiagnostic()) }}>Skip and start from the beginning</button></p>
          )}
          {lesson !== null && (mode === 'teach' || mode === 'remedial') && (
            <LessonPanel view={lesson} completeLabel={mode === 'teach' ? 'Continue to practice' : 'Back to practice'}
              onAnswered={() => { void api.lesson().then(setLesson) }}
              onComplete={() => { void act(() => api.completeLesson(), 'On to practice.') }} />
          )}
          {lastAttempt?.checkpoint !== undefined && <CheckpointResult checkpoint={lastAttempt.checkpoint} />}
          {state?.checkpoint !== null && state?.checkpoint !== undefined && lastAttempt?.checkpoint === undefined && mode !== 'checkpoint' && state.checkpoint.result !== undefined && journey?.stage === 'remedial' && <CheckpointResult checkpoint={state.checkpoint} />}
          {mode === 'practice' && (
            <div className="controls">
              {lastAttempt !== null && !lastAttempt.canRetry && lastAttempt.status !== 'continue' && <button type="button" disabled={busy} onClick={() => { setLastAttempt(null); void act(() => api.nextExercise()) }}>Next exercise</button>}
              <button type="button" className={readyForCheckpoint ? '' : 'secondary'} disabled={busy} onClick={() => { void act(() => api.startCheckpoint(), 'Checkpoint started. Work on your own.') }}>
                {readyForCheckpoint ? 'Take the checkpoint' : 'Try the checkpoint now'}
              </button>
            </div>
          )}
          {mode === 'rest' && journey?.nextAction.type === 'rest' && <p>{journey.nextAction.reason}.</p>}
          {mode === 'complete' && journey !== null && (
            <section><h2>Goal reached</h2><p>You mastered {journey.progress.mastered} skill(s). {journey.dueReviews > 0 ? 'Some skills are due for review.' : 'Reviews will be scheduled.'}</p>
              {journey.dueReviews > 0 && <button type="button" disabled={busy} onClick={() => { void act(() => api.startReview()) }}>Review now</button>}
            </section>
          )}
          {journey !== null && journey.dueReviews > 0 && mode === 'practice' && <button type="button" className="secondary" disabled={busy} onClick={() => { void act(() => api.startReview()) }}>Review {journey.dueReviews} due skill(s)</button>}
        </section>
        <section className="environment-pane" aria-label="Exercise">
          {showExercise && exercise !== null
            ? <ExercisePanel exercise={exercise} announce={setAnnouncement} onError={setError}
                onAttempt={result => { setLastAttempt(result); void refresh() }} />
            : <p className="placeholder">{mode === 'teach' ? 'The exercise board appears when you start practising.' : mode === 'start' ? 'Choose a course to begin.' : ''}</p>}
          {journey !== null && journey.environments.some(e => !e.available) && <p className="warning">Some environments of this course are not installed; your progress is saved and resumes when they are.</p>}
        </section>
      </main>
      {journey !== null && <PathFooter journey={journey} />}
    </div>
  )
}
