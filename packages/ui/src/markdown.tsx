/**
 * A small, safe Markdown renderer for tutor-written text: paragraphs,
 * headings, lists, fenced code, inline code, bold, italic and math.
 * It builds React elements only; no HTML from the text is ever interpreted.
 * Math (`$…$`, `$$…$$`) is typeset by KaTeX into its own element, with
 * `trust` off (no links, classes or other HTML-producing commands); a
 * formula KaTeX cannot parse is shown as its source.
 */
import { useLayoutEffect, useRef, type ReactNode } from 'react'
import katex from 'katex'

/** One formula, typeset by KaTeX. */
export function TeX(props: { readonly tex: string; readonly display?: boolean }): React.ReactElement {
  const ref = useRef<HTMLSpanElement | null>(null)
  const display = props.display === true
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    katex.render(props.tex, el, { displayMode: display, throwOnError: false, trust: false, strict: 'ignore', maxSize: 20, maxExpand: 500, output: 'htmlAndMathml' })
  }, [props.tex, display])
  return <span ref={ref} className={display ? 'math display' : 'math'} />
}

const INLINE = /(`[^`]+`|\$\$[^$]+\$\$|\$[^$\n]+\$|\*\*[^*]+\*\*|\*[^*\n]+\*|_[^_\n]+_)/gu

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  for (const match of text.matchAll(INLINE)) {
    const token = match[0]
    const at = match.index
    if (at > last) out.push(text.slice(last, at))
    const key = `${keyBase}-${i}`
    i += 1
    if (token.startsWith('`')) out.push(<code key={key}>{token.slice(1, -1)}</code>)
    else if (token.startsWith('$$')) out.push(<TeX key={key} tex={token.slice(2, -2)} display />)
    else if (token.startsWith('$')) out.push(<TeX key={key} tex={token.slice(1, -1)} />)
    else if (token.startsWith('**')) out.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    else out.push(<em key={key}>{token.slice(1, -1)}</em>)
    last = at + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/**
 * Render one line of Markdown without paragraphs (for summaries and labels).
 * @param props - the text.
 * @returns inline elements.
 */
export function InlineMarkdown(props: { readonly text: string }): React.ReactElement {
  return <>{inline(props.text, 'i')}</>
}

/**
 * Render Markdown text.
 * @param props - the text.
 * @returns the rendered blocks.
 */
export function Markdown(props: { readonly text: string }): React.ReactElement {
  const blocks: ReactNode[] = []
  const lines = props.text.replace(/\r\n?/gu, '\n').split('\n')
  let i = 0
  let paragraph: string[] = []
  const flush = (): void => {
    if (paragraph.length === 0) return
    const key = `p${blocks.length}`
    blocks.push(<p key={key}>{inline(paragraph.join(' '), key)}</p>)
    paragraph = []
  }
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (line.startsWith('```')) {
      flush()
      const body: string[] = []
      i += 1
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) {
        body.push(lines[i] ?? '')
        i += 1
      }
      i += 1
      blocks.push(<pre key={`c${blocks.length}`}><code>{body.join('\n')}</code></pre>)
      continue
    }
    if (line.trim() === '$$') {
      flush()
      const body: string[] = []
      i += 1
      while (i < lines.length && (lines[i] ?? '').trim() !== '$$') {
        body.push(lines[i] ?? '')
        i += 1
      }
      i += 1
      blocks.push(<TeX key={`m${blocks.length}`} tex={body.join('\n')} display />)
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/u.exec(line)
    if (heading !== null) {
      flush()
      const key = `h${blocks.length}`
      blocks.push(<p key={key} className="md-heading"><strong>{inline(heading[2] ?? '', key)}</strong></p>)
      i += 1
      continue
    }
    if (/^\s*([-*]|\d+[.)])\s+/u.test(line)) {
      flush()
      const ordered = /^\s*\d/u.test(line)
      const items: string[] = []
      while (i < lines.length && /^\s*([-*]|\d+[.)])\s+/u.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*([-*]|\d+[.)])\s+/u, ''))
        i += 1
      }
      const key = `l${blocks.length}`
      const children = items.map((item, n) => <li key={`${key}-${n}`}>{inline(item, `${key}-${n}`)}</li>)
      blocks.push(ordered ? <ol key={key}>{children}</ol> : <ul key={key}>{children}</ul>)
      continue
    }
    if (line.trim() === '') flush()
    else paragraph.push(line.trim())
    i += 1
  }
  flush()
  return <div className="markdown">{blocks}</div>
}
