// Inline serialisation helpers shared by both parsers, so lifted text (exercise prompts, choices, hints)
// is produced the same way in both arms.
import type { LNode } from './types.ts'

export const isBlankNode = (n: LNode) =>
  (n.kind === 'prose' && n.type === 'text' && !(n.text ?? '').trim()) || (n.kind === 'prose' && n.type === 'br')

/** Inline Markdown text of a node list; lesson blocks contribute their inner text only. */
export function inlineMd(nodes: LNode[]): string {
  let s = ''
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
        s += n.text ?? ''
        break
      case 'br':
        s += ' '
        break
      case 'code':
        s += `\`${n.text ?? ''}\``
        break
      case 'strong':
        s += `**${inlineMd(n.children)}**`
        break
      case 'em':
        s += `*${inlineMd(n.children)}*`
        break
      case 'del':
        s += `~~${inlineMd(n.children)}~~`
        break
      case 'link':
        s += `[${inlineMd(n.children)}](${n.attrs.href ?? ''})`
        break
      default:
        s += inlineMd(n.children)
    }
  }
  return s.replace(/\s+/g, ' ').trim()
}
