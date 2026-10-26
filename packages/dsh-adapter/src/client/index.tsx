/**
 * Browser half of the Hodos DSH plugin: a right-sidebar tab type ("Hodos
 * learning") whose body is the Hodos workspace, served by the host half at
 * `/hodos/app/` and bound to the session the tab is open in.
 *
 * Built by `scripts/build.mjs` into DSH's client module format; `react` is
 * the platform's copy (injected `require`), everything else is bundled.
 * @module @hodos/dsh/client
 */
import * as React from 'react'

/** Tab type id; also the slot key of the tab body. */
export const TAB_ID = 'hodos/workspace'

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
 * The workspace iframe. It is same-origin first-party content (the Hodos
 * app); environment renderers inside it run in their own sandboxed iframes.
 * It has no sandbox: it needs scripts and its same-origin API (authenticated
 * by the Harness cookie), and a sandbox that allows both is no boundary.
 */
export function Workspace(props: { sessionId?: string }): React.ReactElement {
  const src = `/hodos/app/?session=${encodeURIComponent(props.sessionId ?? '')}`
  return React.createElement('iframe', {
    src,
    title: 'Hodos',
    'data-testid': 'hodos-workspace',
    referrerPolicy: 'same-origin',
    style: { width: '100%', height: '100%', border: 0, display: 'block' },
  })
}

/** Services this client plugin needs. */
export const inject = ['slots', 'sidebarRightTabs']

/**
 * Register the tab type and its body.
 * @param ctx - client plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: 'hodos',
    title: () => 'Hodos',
    guide: [{ id: 'learn', order: 50, title: () => 'Hodos learning', description: () => 'Adaptive lessons, practice and checkpoints' }],
  }), 'hodos tab type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: TAB_ID,
    inject: sessionId => ({ sessionId }),
  }, Workspace)), 'hodos tab body')
}
