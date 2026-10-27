/**
 * Browser half of the Hodos DSH plugin: two right-sidebar tab types, "Hodos"
 * (the chat's learning or practice session) and "Knowledge graph" (the
 * learner's graph). Both bodies are the Hodos app, served by the host half at
 * `/hodos/app/` and bound to the chat the tab is open in.
 *
 * Built by `scripts/build.mjs` into DSH's client module format; `react` is
 * the platform's copy (injected `require`), everything else is bundled.
 * @module @hodos/dsh/client
 */
import * as React from 'react'

/** Tab type id of the session panel; also the slot key of its body. */
export const TAB_ID = 'hodos/workspace'
/** Tab type id of the knowledge graph. */
export const GRAPH_TAB_ID = 'hodos/graph'

/** Structural view of the DSH client services this module uses. */
interface ClientContext {
  effect(execute: () => () => void, label?: string): void
  readonly sidebarRightTabs: {
    register(definition: {
      id: string
      kind: string
      title: () => string
      guide?: ReadonlyArray<{ id: string; order: number; title: () => string; description?: () => string }>
    }): () => void
  }
  readonly slots: {
    inject(key: string, callback: () => () => void): () => void
    register(options: { name: string; key: string; inject: (sessionId: string) => { sessionId: string } }, component: React.ComponentType<{ sessionId?: string }>): () => void
  }
}

/**
 * The Hodos app in a frame. It is same-origin first-party content: it needs
 * scripts and its same-origin API (authenticated by the Harness cookie), and
 * a sandbox that allows both is no boundary. Environment renderers inside it
 * run in their own sandboxed iframes.
 */
function frame(view: 'workspace' | 'graph', sessionId: string | undefined, title: string): React.ReactElement {
  const src = `/hodos/app/?${view === 'graph' ? 'view=graph&' : ''}session=${encodeURIComponent(sessionId ?? '')}`
  return React.createElement('iframe', {
    src,
    title,
    'data-testid': view === 'graph' ? 'hodos-graph' : 'hodos-workspace',
    referrerPolicy: 'same-origin',
    style: { width: '100%', height: '100%', border: 0, display: 'block' },
  })
}

/** The session panel. */
export function Workspace(props: { sessionId?: string }): React.ReactElement {
  return frame('workspace', props.sessionId, 'Hodos')
}

/** The knowledge graph. */
export function KnowledgeGraph(props: { sessionId?: string }): React.ReactElement {
  return frame('graph', props.sessionId, 'Hodos knowledge graph')
}

/** Services this client plugin needs. */
export const inject = ['slots', 'sidebarRightTabs']

/**
 * Register the tab types and their bodies.
 * @param ctx - client plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: 'hodos',
    title: () => 'Hodos',
    guide: [{ id: 'learn', order: 50, title: () => 'Hodos learning', description: () => 'Learn anything: probe, plan and teach, with questions here' }],
  }), 'hodos tab type')
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: GRAPH_TAB_ID,
    kind: 'hodos-graph',
    title: () => 'Knowledge graph',
    guide: [{ id: 'graph', order: 51, title: () => 'Knowledge graph', description: () => 'Everything you learned, as ideas and how they follow from each other' }],
  }), 'hodos graph tab type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: TAB_ID,
    inject: sessionId => ({ sessionId }),
  }, Workspace)), 'hodos tab body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: GRAPH_TAB_ID,
    inject: sessionId => ({ sessionId }),
  }, KnowledgeGraph)), 'hodos graph tab body')
}
