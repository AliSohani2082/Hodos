// Format-normalised plain rendering of a lesson (§8.5 Q1/Q2): the judge and the human reviewer see this, never
// the source syntax, so neither arm's markup can bias them.
import { REGISTRY } from './blocks.ts'
import type { LDoc, LNode } from './types.ts'

function inline(nodes: LNode[]): string {
  let s = ''
  for (const n of nodes) {
    if (n.kind === 'block') {
      const spec = REGISTRY.get(n.type)
      s += spec ? spec.plain(n, inline(n.children)) : inline(n.children)
      continue
    }
    switch (n.type) {
      case 'text': s += n.text ?? ''; break
      case 'br': s += '\n'; break
      case 'code': s += `\`${n.text ?? ''}\``; break
      case 'strong': s += `**${inline(n.children)}**`; break
      case 'em': s += `*${inline(n.children)}*`; break
      case 'del': s += `~~${inline(n.children)}~~`; break
      case 'link': s += `[${inline(n.children)}](${n.attrs.href ?? ''})`; break
      case 'image': s += `[image: ${n.attrs.alt ?? ''}]`; break
      default: s += inline(n.children)
    }
  }
  return s
}

function blocks(nodes: LNode[], depth = 0): string[] {
  const out: string[] = []
  for (const n of nodes) {
    if (n.kind === 'block') {
      const spec = REGISTRY.get(n.type)
      const inner = blocks(n.children, depth).join('\n\n')
      out.push(spec ? spec.plain(n, spec.kind === 'inline' ? inline(n.children) : inner) : inner)
      continue
    }
    switch (n.type) {
      case 'heading': out.push(`${'#'.repeat(Number(n.attrs.level) || 1)} ${inline(n.children)}`); break
      case 'paragraph': out.push(inline(n.children)); break
      case 'fence': out.push('```' + String(n.attrs.language ?? '') + '\n' + (n.text ?? '').replace(/\n$/, '') + '\n```'); break
      case 'hr': out.push('---'); break
      case 'quote': out.push(blocks(n.children, depth).join('\n\n').split('\n').map((l) => `> ${l}`).join('\n')); break
      case 'list': {
        const items = n.children.map((it, i) => {
          const body = blocks(it.children, depth + 1).join('\n').split('\n').map((l, j) => (j ? '  ' + l : l)).join('\n')
          return `${n.attrs.ordered ? `${i + 1}.` : '-'} ${body}`
        })
        out.push(items.join('\n'))
        break
      }
      case 'text': if ((n.text ?? '').trim()) out.push(n.text!.trim()); break
      default: {
        const inner = blocks(n.children, depth).join('\n')
        if (inner) out.push(inner)
      }
    }
  }
  return out
}

export function renderPlain(doc: LDoc): string {
  const head = doc.frontmatter.concept ? `Concept: ${doc.frontmatter.concept}\n\n` : ''
  return head + blocks(doc.children).join('\n\n') + '\n'
}
