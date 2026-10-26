/**
 * The environment pane: one exercise, rendered by its environment's
 * sandboxed renderer when installed, otherwise by an accessible generic form
 * built from the plain-text projection.
 */
import { useEffect, useRef, useState } from 'react'
import type { AttemptView, ExerciseView, HintView } from '@hodos/core'
import type { JsonValue } from '@hodos/plugin-sdk/protocol'
import { api, ApiError } from './api.js'
import { RendererFrame, type RendererHandle } from './renderer-frame.js'

interface Props {
  readonly exercise: ExerciseView
  /** The grader's answer (or a new exercise is needed); parent refreshes state. */
  readonly onAttempt: (result: AttemptView) => void
  readonly onError: (message: string) => void
  readonly announce: (message: string) => void
}

const MODE_LABEL: Readonly<Record<string, string>> = {
  diagnostic: 'Placement question',
  practice: 'Practice',
  checkpoint: 'Checkpoint — on your own',
  review: 'Review',
}

function optionsOf(payload: JsonValue): Array<{ id: string; text: string }> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return []
  const options = payload.options
  if (!Array.isArray(options)) return []
  return options.flatMap(o => (typeof o === 'object' && o !== null && !Array.isArray(o) && typeof o.id === 'string' && typeof o.text === 'string' ? [{ id: o.id, text: o.text }] : []))
}

/** Generic answer form for exercises without an installed renderer. */
function GenericAnswer(props: { exercise: ExerciseView; disabled: boolean; onSubmit: (response: JsonValue) => void }): React.ReactElement {
  const [value, setValue] = useState('')
  const { exercise } = props
  const options = optionsOf(exercise.payload)
  const field = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  useEffect(() => { setValue(''); field.current?.focus() }, [exercise.id, exercise.attempt])
  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    if (value.trim() === '') return
    switch (exercise.responseKind) {
      case 'choice': props.onSubmit({ choice: value }); break
      case 'moves': props.onSubmit({ move: value.trim() }); break
      case 'number': props.onSubmit({ value: Number(value) }); break
      case 'code': props.onSubmit({ code: value }); break
      case 'structured': {
        try {
          props.onSubmit(JSON.parse(value) as JsonValue)
        } catch (_invalid) {
          props.onSubmit({ text: value })
        }
        break
      }
      default: props.onSubmit({ text: value })
    }
  }
  if (exercise.responseKind === 'choice' && options.length > 0) {
    return (
      <form className="answer" onSubmit={submit}>
        <fieldset disabled={props.disabled}>
          <legend className="sr-only">Choose one answer</legend>
          {options.map((o, i) => (
            <label key={o.id} className="choice">
              <input type="radio" name={`choice-${exercise.id}`} value={o.id} checked={value === o.id} onChange={() => setValue(o.id)} autoFocus={i === 0} />
              <span>{o.text}</span>
            </label>
          ))}
        </fieldset>
        <button type="submit" disabled={props.disabled || value === ''}>Submit answer</button>
      </form>
    )
  }
  const multiline = exercise.responseKind === 'code' || exercise.responseKind === 'structured'
  return (
    <form className="answer" onSubmit={submit}>
      <label className="field">
        <span>{exercise.responseKind === 'moves' ? 'Or type your move (e.g. Nf3)' : 'Your answer'}</span>
        {multiline
          ? <textarea ref={el => { field.current = el }} value={value} onChange={e => setValue(e.target.value)} disabled={props.disabled} rows={8} spellCheck={false} />
          : <input ref={el => { field.current = el }} value={value} onChange={e => setValue(e.target.value)} disabled={props.disabled} autoComplete="off" />}
      </label>
      <button type="submit" disabled={props.disabled || value.trim() === ''}>Submit answer</button>
    </form>
  )
}

/** The exercise with feedback, hints and controls. */
export function ExercisePanel(props: Props): React.ReactElement {
  const { exercise } = props
  const frame = useRef<RendererHandle | null>(null)
  const shownAt = useRef(Date.now())
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<AttemptView | null>(null)
  const [hints, setHints] = useState<HintView[]>([])
  const assessment = exercise.mode === 'checkpoint' || exercise.mode === 'diagnostic'
  // State refreshes replace the object; the board is re-presented only for a new exercise id.
  const latest = useRef(exercise)
  latest.current = exercise

  useEffect(() => {
    shownAt.current = Date.now()
    setResult(null)
    setHints([])
    frame.current?.post({ type: 'hodos:present', exercise: latest.current })
    frame.current?.post({ type: 'hodos:lock', locked: false })
  }, [exercise.id])

  const submit = async (response: JsonValue): Promise<void> => {
    if (busy) return
    setBusy(true)
    frame.current?.post({ type: 'hodos:lock', locked: true })
    try {
      const outcome = await api.submit(exercise.id, response, Date.now() - shownAt.current)
      setResult(outcome)
      if (outcome.status === 'continue') {
        frame.current?.post({ type: 'hodos:progress', exerciseId: exercise.id, progress: outcome.progress ?? null, ...(outcome.message === undefined ? {} : { message: outcome.message }) })
        frame.current?.post({ type: 'hodos:lock', locked: false })
        props.announce(outcome.message ?? 'Step accepted.')
      } else if (outcome.status === 'recorded') {
        props.announce('Answer recorded.')
      } else {
        frame.current?.post({
          type: 'hodos:result', exerciseId: exercise.id, correct: outcome.status === 'correct', score: outcome.score ?? 0,
          ...(outcome.reveal === undefined ? {} : { reveal: outcome.reveal }),
        })
        if (outcome.canRetry) frame.current?.post({ type: 'hodos:lock', locked: false })
        props.announce(outcome.status === 'correct' ? 'Correct.' : outcome.feedback ?? 'Not quite.')
      }
      props.onAttempt(outcome)
    } catch (error) {
      frame.current?.post({ type: 'hodos:lock', locked: false })
      props.onError(error instanceof ApiError ? error.message : 'Something went wrong; try again.')
    } finally {
      setBusy(false)
    }
  }

  const hint = async (): Promise<void> => {
    try {
      const h = await api.hint(exercise.id)
      setHints(previous => [...previous.filter(p => p.level !== h.level), h])
      props.announce(`Hint ${h.level}: ${h.text}`)
    } catch (error) {
      props.onError(error instanceof ApiError ? error.message : 'No hint is available right now.')
    }
  }

  const finished = result !== null && result.status !== 'continue' && !result.canRetry
  const shownHints = [...exercise.hints.map(h => ({ level: h.level, text: h.text })), ...hints.map(h => ({ level: h.level, text: h.text }))]
    .filter((h, i, all) => all.findIndex(x => x.level === h.level) === i).sort((a, b) => a.level - b.level)

  return (
    <section className={`exercise mode-${exercise.mode}`} aria-labelledby="exercise-title">
      <header className="exercise-head">
        <span className={`mode-badge mode-${exercise.mode}`}>{MODE_LABEL[exercise.mode] ?? exercise.mode}</span>
        <h2 id="exercise-title" tabIndex={-1}>{exercise.title} · {exercise.skillTitle}</h2>
        {exercise.checkpoint !== undefined && <span className="counter">Item {exercise.checkpoint.index} of {exercise.checkpoint.total}</span>}
        {exercise.diagnostic !== undefined && <span className="counter">Question {exercise.diagnostic.asked + 1}</span>}
      </header>
      {assessment && <p className="notice assessment">Answer on your own: no hints and no tutor help. {exercise.mode === 'checkpoint' ? 'Results appear when the checkpoint ends.' : 'This only decides where you start.'}</p>}
      {exercise.renderer !== null
        ? (
          <RendererFrame
            ref={frame}
            renderer={exercise.renderer}
            environment={exercise.environment}
            title={`${exercise.title} board`}
            capabilities={['respond', 'resize']}
            onReady={() => {
              frame.current?.post({ type: 'hodos:present', exercise })
              if (busy || finished) frame.current?.post({ type: 'hodos:lock', locked: true })
            }}
            onResponse={(exerciseId, response) => { if (exerciseId === exercise.id && !finished) void submit(response) }}
          />
        )
        : <p className="prompt">{exercise.fallbackText}</p>}
      {exercise.renderer !== null && <details className="text-alternative"><summary>Text version</summary><pre>{exercise.fallbackText}</pre></details>}
      {!finished && <GenericAnswer exercise={exercise} disabled={busy} onSubmit={response => { void submit(response) }} />}
      <div className="controls">
        {exercise.mode === 'diagnostic' && !finished && <button type="button" onClick={() => { void submit({ dontKnow: true }) }} disabled={busy}>I don't know</button>}
        {exercise.hintsAvailable > 0 && !finished && <button type="button" onClick={() => { void hint() }} disabled={busy}>Hint ({exercise.hintsAvailable} left)</button>}
      </div>
      {shownHints.length > 0 && (
        <ol className="hints" aria-label="Hints">
          {shownHints.map(h => <li key={h.level} value={h.level}>{h.text}</li>)}
        </ol>
      )}
      {result !== null && <AttemptFeedback result={result} />}
    </section>
  )
}

function AttemptFeedback(props: { result: AttemptView }): React.ReactElement | null {
  const r = props.result
  if (r.status === 'recorded' && r.checkpoint?.result === undefined) return null
  return (
    <div className={`feedback status-${r.status}`} role="status">
      {r.status === 'correct' && <p><strong>Correct.</strong> {r.feedback}</p>}
      {(r.status === 'incorrect' || r.status === 'partial') && <p><strong>{r.status === 'partial' ? 'Partly right.' : 'Not quite.'}</strong> {r.feedback}</p>}
      {r.status === 'continue' && <p>{r.message ?? 'Good — keep going.'}</p>}
      {r.misconceptionFeedback?.map(m => <p key={m} className="misconception">{m}</p>)}
      {r.explanation !== undefined && <p className="explanation">{r.explanation}</p>}
      {r.stuck && <p>Several misses in a row — ask for a hint or talk it through with your tutor.</p>}
      {r.canRetry && <p>{r.attemptsLeft} attempt(s) left.</p>}
    </div>
  )
}
