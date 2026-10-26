/**
 * Lesson rendering: the projected, schema-validated lesson tree becomes
 * React elements. Lessons are data — there is no HTML injection and no
 * executable content; plugin blocks either show in their environment's
 * sandboxed renderer or as their plain-text meaning.
 */
import { useRef, useState } from 'react'
import type { LessonView } from '@hodos/core'
import type { LessonNode } from '@hodos/plugin-sdk/protocol'
import { api, ApiError } from './api.js'
import { RendererFrame, type RendererHandle } from './renderer-frame.js'

type Lesson = LessonView['lessons'][number]

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function Inline(props: { node: LessonNode }): React.ReactElement {
  const { node } = props
  const children = (node.children ?? []).map(c => <Inline key={c.id} node={c} />)
  switch (node.type) {
    case 'text': return <>{node.text ?? ''}</>
    case 'code': return <code>{node.text ?? ''}</code>
    case 'strong': return <strong>{children}</strong>
    case 'em': return <em>{children}</em>
    case 'strike': return <s>{children}</s>
    case 'break': return <br />
    case 'link': {
      const href = str(node.attributes.href)
      // The server only admits http(s), mailto and in-page links.
      return /^(https?:|mailto:|#)/i.test(href) ? <a href={href} target={href.startsWith('#') ? undefined : '_blank'} rel="noopener noreferrer">{children}</a> : <span>{children}</span>
    }
    default: return <>{children}</>
  }
}

function BlockFrame(props: { node: LessonNode; block: Lesson['blocks'][string] }): React.ReactElement {
  const frame = useRef<RendererHandle | null>(null)
  if (props.block.renderer === null) return <div className="block-fallback">{props.block.text}</div>
  return (
    <figure className="block-frame">
      <RendererFrame
        ref={frame}
        renderer={props.block.renderer}
        environment={props.block.type}
        title={props.block.text.slice(0, 80) || props.node.type}
        capabilities={['resize']}
        initialHeight={360}
        onReady={() => frame.current?.post({ type: 'hodos:block', block: props.node })}
      />
      {/* A one-line text version is a caption; a longer one (a program, a table) would repeat the block, so it folds away. */}
      {props.block.text.includes('\n')
        ? <details className="text-alternative"><summary>Text version</summary><pre>{props.block.text}</pre></details>
        : <figcaption>{props.block.text}</figcaption>}
    </figure>
  )
}

function Check(props: { lesson: Lesson; node: LessonNode; onAnswered: () => void }): React.ReactElement {
  const { node, lesson } = props
  const status = lesson.checks.find(c => c.id === node.id)
  const [choice, setChoice] = useState('')
  const [answer, setAnswer] = useState<{ correct: boolean; explanation?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const options = Array.isArray(node.attributes.options) ? node.attributes.options.flatMap(o => (typeof o === 'object' && o !== null && !Array.isArray(o) ? [{ id: str(o.id), text: str(o.text) }] : [])) : []
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (choice === '') return
    try {
      const result = await api.answerCheck(lesson.id, node.id, choice)
      setAnswer(result.explanation === undefined ? { correct: result.correct } : { correct: result.correct, explanation: result.explanation })
      setError(null)
      props.onAnswered()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not check the answer.')
    }
  }
  return (
    <form className="check" onSubmit={e => { void submit(e) }}>
      <fieldset>
        <legend>{str(node.attributes.question)}</legend>
        {options.map(o => (
          <label key={o.id} className="choice">
            <input type="radio" name={`check-${node.id}`} value={o.id} checked={choice === o.id} onChange={() => setChoice(o.id)} />
            <span>{o.text}</span>
          </label>
        ))}
      </fieldset>
      <button type="submit" disabled={choice === ''}>Check</button>
      {status?.answered === true && answer === null && <p className="check-status">{status.correct ? 'Answered correctly.' : 'Answered — try again if you like.'}</p>}
      {answer !== null && (
        <p className={answer.correct ? 'check-status correct' : 'check-status incorrect'} role="status">
          <strong>{answer.correct ? 'Right.' : 'Not quite.'}</strong> {answer.explanation}
        </p>
      )}
      {error !== null && <p className="error" role="alert">{error}</p>}
    </form>
  )
}

function Block(props: { lesson: Lesson; node: LessonNode; depth: number; onAnswered: () => void }): React.ReactElement {
  const { node, lesson } = props
  const children = (node.children ?? []).map(c => <Block key={c.id} lesson={lesson} node={c} depth={props.depth + 1} onAnswered={props.onAnswered} />)
  switch (node.type) {
    case 'document': return <>{children}</>
    case 'heading': {
      const level = Math.min(6, Math.max(3, Number(node.attributes.level ?? 1) + 2))
      const inner = (node.children ?? []).map(c => <Inline key={c.id} node={c} />)
      return level === 3 ? <h3>{inner}</h3> : level === 4 ? <h4>{inner}</h4> : level === 5 ? <h5>{inner}</h5> : <h6>{inner}</h6>
    }
    case 'paragraph': return <p>{(node.children ?? []).map(c => <Inline key={c.id} node={c} />)}</p>
    case 'list': return node.attributes.ordered === true ? <ol>{children}</ol> : <ul>{children}</ul>
    case 'item': return <li>{(node.children ?? []).map(c => (c.type === 'paragraph' ? <Inline key={c.id} node={c} /> : <Block key={c.id} lesson={lesson} node={c} depth={props.depth + 1} onAnswered={props.onAnswered} />))}</li>
    case 'blockquote': return <blockquote>{children}</blockquote>
    case 'fence': return <pre><code>{node.text ?? ''}</code></pre>
    case 'rule': return <hr />
    case 'step': return <section className="step">{str(node.attributes.title) !== '' && <h4>{str(node.attributes.title)}</h4>}{children}</section>
    case 'callout': return <aside className={`callout callout-${str(node.attributes.kind) || 'note'}`}>{str(node.attributes.title) !== '' && <strong>{str(node.attributes.title)}</strong>}{children}</aside>
    case 'worked-example': return <section className="worked-example"><h4>Worked example{str(node.attributes.title) !== '' ? `: ${str(node.attributes.title)}` : ''}</h4>{children}</section>
    case 'check': return <Check lesson={lesson} node={node} onAnswered={props.onAnswered} />
    default: {
      const block = lesson.blocks[node.id]
      if (block !== undefined) return <BlockFrame node={node} block={block} />
      return <>{(node.children ?? []).map(c => <Inline key={c.id} node={c} />)}</>
    }
  }
}

/** The tutor pane during teach and remedial stages. */
export function LessonPanel(props: { view: LessonView; onAnswered: () => void; onComplete: () => void; completeLabel: string }): React.ReactElement {
  return (
    <section className="lesson" aria-label="Lesson">
      {props.view.lessons.map(lesson => (
        <article key={lesson.id} className={`lesson-body origin-${lesson.origin}`}>
          <h2>{lesson.title}</h2>
          {lesson.origin !== 'course' && <p className="provenance">{lesson.origin === 'generated' ? 'Outline generated from the skill description.' : 'Written for you by your tutor; not independently verified.'}</p>}
          <Block lesson={lesson} node={lesson.tree} depth={0} onAnswered={props.onAnswered} />
        </article>
      ))}
      <div className="controls">
        <button type="button" onClick={props.onComplete} disabled={!props.view.canComplete}>{props.completeLabel}</button>
        {!props.view.canComplete && <span className="hint-text">Answer the check questions first.</span>}
      </div>
    </section>
  )
}
