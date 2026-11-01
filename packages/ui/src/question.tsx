/**
 * Questions in the panel. The open question is answered here: options,
 * an answer in the learner's own words, or an environment's interface (a
 * board, an editor) in its sandboxed renderer. Every form has an optional
 * "think out loud" field and an "I don't know". The server grades; the
 * reveal (the committed answer, the explanation, a plugin's solution)
 * appears only with the verdict.
 */
import { useEffect, useRef, useState } from 'react'
import type { QuestionView, RendererRef } from '@hodos/core'
import { RENDERER_CAPABILITIES, type Exercise, type JsonValue, type RendererCapability } from '@hodos/plugin-sdk/protocol'
import { api, errorText, type RendererEntry } from './api.js'
import { InlineMarkdown, Markdown } from './markdown.js'
import { RendererFrame, type RendererHandle } from './renderer-frame.js'

type InterfaceForm = Extract<QuestionView['form'], { type: 'interface' }>

const ROLE_LABEL: Readonly<Record<string, string>> = { probe: 'Where are you?', predict: 'Predict', check: 'Check', review: 'Review' }
const OUTCOME_LABEL: Readonly<Record<string, string>> = { correct: 'Correct.', partial: 'Partly right.', incorrect: 'Not quite.', 'dont-know': 'You said you don\'t know.', ungraded: 'Sent to your tutor.' }

/** The renderer protocol's view of an interface question. */
function exerciseOf(q: QuestionView, form: InterfaceForm): Exercise {
  return {
    id: q.id, itemId: q.id, kind: form.kind, environment: form.environment,
    skills: [{ skillId: q.nodeId ?? 'session', weight: 1 }], difficulty: 0, payload: form.payload,
    mode: 'practice', hintsAvailable: 0, attempt: 1, ...(q.progress === undefined ? {} : { progress: q.progress }),
  }
}

function optionsOf(payload: JsonValue): Array<{ id: string; text: string }> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return []
  const options = payload.options
  if (!Array.isArray(options)) return []
  return options.flatMap(o => (typeof o === 'object' && o !== null && !Array.isArray(o) && typeof o.id === 'string' && typeof o.text === 'string' ? [{ id: o.id, text: o.text }] : []))
}

/** A plain answer for an interface without an installed renderer, in the kind's one response field. */
function genericResponse(form: InterfaceForm, value: string): JsonValue {
  const field = form.answerField
  if (field === null) {
    try {
      return JSON.parse(value) as JsonValue
    } catch {
      return { text: value }
    }
  }
  return { [field.name]: field.type === 'string' ? value : Number(value) }
}

/** An installed renderer with the capabilities the host granted it. */
export interface InstalledRenderer {
  readonly ref: RendererRef
  readonly capabilities: readonly RendererCapability[]
}

interface OpenProps {
  readonly question: QuestionView
  readonly renderers: ReadonlyMap<string, InstalledRenderer>
  readonly onDone: () => void
  readonly announce: (message: string) => void
}

/** The open question with its answer form. */
export function OpenQuestion(props: OpenProps): React.ReactElement {
  const q = props.question
  const collapsed = q.role === 'check' || q.role === 'review'
  const [expanded, setExpanded] = useState(!collapsed)
  const [selected, setSelected] = useState<string[]>([])
  const [text, setText] = useState('')
  const [thinking, setThinking] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stepMessage, setStepMessage] = useState<string | null>(null)
  const frame = useRef<RendererHandle | null>(null)
  const form = q.form
  const renderer = form.type === 'interface' ? props.renderers.get(form.environment) : undefined
  // A renderer answers for the learner only if it may respond; otherwise it draws and the panel takes the answer.
  const interactive = renderer?.capabilities.includes('respond') ?? false

  const submit = async (answer: { response?: JsonValue; dontKnow?: boolean }): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    frame.current?.post({ type: 'hodos:lock', locked: true })
    try {
      const result = await api.answer(q.id, { ...answer, ...(thinking.trim() === '' ? {} : { thinking }) })
      if (result.status === 'continue') {
        frame.current?.post({ type: 'hodos:progress', exerciseId: q.id, progress: result.question.progress ?? null, ...(result.message === undefined ? {} : { message: result.message }) })
        frame.current?.post({ type: 'hodos:lock', locked: false })
        setStepMessage(result.message ?? 'Good, keep going.')
        props.announce(result.message ?? 'Step accepted.')
      } else {
        const verdict = result.question.answer?.verdict
        frame.current?.post({ type: 'hodos:result', exerciseId: q.id, correct: verdict?.outcome === 'correct', score: verdict?.score ?? 0, ...(result.question.answer?.reveal.solution === undefined ? {} : { reveal: result.question.answer.reveal.solution }) })
        props.announce(OUTCOME_LABEL[verdict?.outcome ?? 'ungraded'] ?? 'Answered.')
        props.onDone()
      }
    } catch (e) {
      frame.current?.post({ type: 'hodos:lock', locked: false })
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const answerForm = (): React.ReactElement | null => {
    switch (form.type) {
      case 'choice':
        return (
          <fieldset className="options" disabled={busy}>
            <legend className="sr-only">{form.multi ? 'Choose every correct answer' : 'Choose one answer'}</legend>
            {form.options.map(o => (
              <label key={o.value} className="choice">
                <input
                  type={form.multi ? 'checkbox' : 'radio'}
                  name={`q-${q.id}`}
                  value={o.value}
                  checked={selected.includes(o.value)}
                  onChange={() => setSelected(prev => (form.multi ? (prev.includes(o.value) ? prev.filter(v => v !== o.value) : [...prev, o.value]) : [o.value]))}
                />
                <span><Markdown text={o.label} /></span>
              </label>
            ))}
          </fieldset>
        )
      case 'explain':
        return (
          <label className="field">
            <span>Your answer, in your own words</span>
            <textarea value={text} onChange={e => setText(e.target.value)} disabled={busy} rows={6} />
          </label>
        )
      case 'interface': {
        const drawn = renderer === undefined
          ? null
          : (
            <RendererFrame
              ref={frame}
              renderer={renderer.ref}
              environment={form.environment}
              title={`${form.kind} question`}
              capabilities={renderer.capabilities}
              onReady={() => frame.current?.post({ type: 'hodos:present', exercise: exerciseOf(q, form) })}
              onResponse={(exerciseId, response) => { if (exerciseId === q.id) void submit({ response }) }}
            />
          )
        if (drawn !== null && interactive) {
          return (
            <>
              {drawn}
              <details className="text-alternative"><summary>Text version</summary><pre>{form.text}</pre></details>
            </>
          )
        }
        // No renderer, or one that only draws (a diagram, a position): the answer is typed or picked here.
        return (
          <>
            {drawn}
            <pre className="prompt-text">{form.text}</pre>
            {form.answerField !== null && optionsOf(form.payload).length > 0
              ? (
                <fieldset className="options" disabled={busy}>
                  <legend className="sr-only">Choose one answer</legend>
                  {optionsOf(form.payload).map(o => (
                    <label key={o.id} className="choice">
                      <input type="radio" name={`q-${q.id}`} value={o.id} checked={text === o.id} onChange={() => setText(o.id)} />
                      <span>{o.text}</span>
                    </label>
                  ))}
                </fieldset>
              )
              : (
                <label className="field">
                  <span>{form.responseKind === 'moves' ? 'Your move (e.g. Nf3)' : form.answerField === null ? 'Your answer (JSON)' : 'Your answer'}</span>
                  <textarea value={text} onChange={e => setText(e.target.value)} disabled={busy} rows={form.responseKind === 'code' ? 10 : 2} spellCheck={form.responseKind !== 'code'} />
                </label>
              )}
          </>
        )
      }
      default: return null
    }
  }

  const canSubmit = !busy && (form.type === 'choice' ? selected.length > 0 : form.type === 'explain' ? text.trim() !== '' : !interactive && text.trim() !== '')
  const submitAnswer = (): void => {
    if (form.type === 'choice') void submit({ response: { selected } })
    else if (form.type === 'explain') void submit({ response: { text } })
    else if (form.type === 'interface') void submit({ response: genericResponse(form, text) })
  }

  return (
    <section className={`question open role-${q.role}`} aria-labelledby={`q-${q.id}-title`}>
      <header className="question-head">
        <span className={`role-badge role-${q.role}`}>{ROLE_LABEL[q.role] ?? q.role}</span>
        {q.origin === 'model' && <span className="provenance" title="Written by the tutor model; Hodos checks its form and grades your answer, but cannot verify the question itself.">Written by the tutor</span>}
      </header>
      {!expanded
        ? <button type="button" className="primary" onClick={() => setExpanded(true)}>Check your understanding</button>
        : (
          <form onSubmit={e => { e.preventDefault(); submitAnswer() }}>
            <h3 id={`q-${q.id}-title`} className="question-prompt"><Markdown text={q.prompt} /></h3>
            {q.details !== undefined && <div className="question-details"><Markdown text={q.details} /></div>}
            {answerForm()}
            {stepMessage !== null && <p className="step-message" aria-live="polite">{stepMessage}</p>}
            <label className="field thinking">
              <span>Think out loud (optional, sent to your tutor)</span>
              <textarea value={thinking} onChange={e => setThinking(e.target.value)} disabled={busy} rows={2} />
            </label>
            {error !== null && <p className="error" role="alert">{error}</p>}
            <div className="controls">
              {(form.type !== 'interface' || !interactive) && <button type="submit" className="primary" disabled={!canSubmit}>Submit</button>}
              <button type="button" onClick={() => { void submit({ dontKnow: true }) }} disabled={busy}>I don't know</button>
            </div>
          </form>
        )}
    </section>
  )
}

/** An answered question with its verdict and reveal. */
export function AnsweredQuestion(props: { readonly question: QuestionView }): React.ReactElement {
  const q = props.question
  const a = q.answer
  const labels = q.form.type === 'choice' ? new Map(q.form.options.map(o => [o.value, o.label])) : new Map<string, string>()
  return (
    <details className={`question answered outcome-${a?.verdict.outcome ?? 'none'}`}>
      <summary>
        <span className={`role-badge role-${q.role}`}>{ROLE_LABEL[q.role] ?? q.role}</span>
        <span className="summary-text"><InlineMarkdown text={q.prompt.split('\n')[0] ?? ''} /></span>
        <span className="outcome">{OUTCOME_LABEL[a?.verdict.outcome ?? ''] ?? ''}</span>
      </summary>
      <div className="question-prompt"><Markdown text={q.prompt} /></div>
      {a !== undefined && (
        <div className="reveal">
          <p><strong>You answered:</strong> <InlineMarkdown text={a.text} /></p>
          {a.thinking !== undefined && <p className="muted"><strong>Your thinking:</strong> {a.thinking}</p>}
          {a.verdict.feedback !== undefined && <p>{a.verdict.feedback}</p>}
          {a.verdict.misconceptionFeedback?.map(text => <p key={text} className="misconception">{text}</p>)}
          {a.reveal.correct !== undefined && <p><strong>Correct:</strong> <InlineMarkdown text={a.reveal.correct.map(v => labels.get(v) ?? v).join(', ')} /></p>}
          {a.reveal.committedAnswer !== undefined && <div><strong>Your tutor's answer:</strong><Markdown text={a.reveal.committedAnswer} /></div>}
          {a.reveal.explanation !== undefined && <div className="explanation"><Markdown text={a.reveal.explanation} /></div>}
          {a.reveal.solution !== undefined && <pre className="solution">{typeof a.reveal.solution === 'string' ? a.reveal.solution : JSON.stringify(a.reveal.solution, null, 2)}</pre>}
        </div>
      )}
    </details>
  )
}

/** Renderers by environment, loaded once. */
export function useRenderers(): ReadonlyMap<string, InstalledRenderer> {
  const [map, setMap] = useState<ReadonlyMap<string, InstalledRenderer>>(new Map())
  useEffect(() => {
    let live = true
    const load = async (): Promise<void> => {
      let list: RendererEntry[]
      try {
        list = await api.renderers()
      } catch {
        // Without renderers, interface questions use the text form.
        return
      }
      if (live) {
        setMap(new Map(list.flatMap(r => (r.renderer === null ? [] : [[r.environment, {
          ref: { pluginId: r.renderer.pluginId, rendererId: r.renderer.rendererId, entry: r.renderer.entry },
          capabilities: r.renderer.capabilities.filter((c): c is RendererCapability => (RENDERER_CAPABILITIES as readonly string[]).includes(c)),
        }] as const]))))
      }
    }
    void load()
    return () => { live = false }
  }, [])
  return map
}
