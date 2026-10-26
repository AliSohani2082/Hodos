/**
 * Browser helper for renderer authors: completes the port handshake and
 * dispatches validated host messages. Browser-safe; pass `window`.
 * @module @hodos/plugin-sdk/renderer
 */
import type { Exercise } from './exercise.js'
import type { JsonValue } from './json.js'
import type { LessonNode } from './lesson.js'
import {
  isConnectMessage,
  parseHostMessage,
  RENDERER_PROTOCOL,
  type HostToRendererMessage,
  type RendererCapability,
} from './protocol.js'

/** The subset of `MessagePort` the helper uses. */
export interface PortLike {
  postMessage(message: unknown): void
  onmessage: ((event: { readonly data: unknown }) => void) | null
}

/** The subset of `Window` the helper uses. */
export interface WindowLike {
  readonly parent: unknown
  addEventListener(
    type: 'message',
    listener: (event: { readonly data: unknown; readonly source: unknown; readonly ports: readonly PortLike[] }) => void,
  ): void
}

/** Callbacks for host messages. Only `onPresent` is required. */
export interface RendererHandlers {
  onInit?(init: Extract<HostToRendererMessage, { type: 'hodos:init' }>): void
  onPresent(exercise: Exercise): void
  onProgress?(exerciseId: string, progress: JsonValue, message?: string): void
  onResult?(result: Extract<HostToRendererMessage, { type: 'hodos:result' }>): void
  onBlock?(block: LessonNode): void
  onLock?(locked: boolean): void
  onClear?(): void
}

/** The renderer's side of an established connection. */
export interface RendererConnection {
  /** Send the learner's response (or one step of it) for the presented exercise. */
  respond(exerciseId: string, response: JsonValue): void
  /** Ask the host to resize the iframe. */
  resize(height: number): void
}

/**
 * Wait for the host's port handoff, then dispatch host messages to handlers.
 * Messages from anything other than the parent window, and malformed host
 * messages, are ignored.
 * @param win - the renderer's `window`.
 * @param handlers - message callbacks.
 * @returns a promise for the connection, resolved after the handshake.
 */
export function connectRenderer(win: WindowLike, handlers: RendererHandlers): Promise<RendererConnection> {
  return new Promise(resolve => {
    let connected = false
    win.addEventListener('message', event => {
      if (connected || event.source !== win.parent || !isConnectMessage(event.data)) return
      const port = event.ports[0]
      if (port === undefined) return
      connected = true
      port.onmessage = message => {
        const parsed = parseHostMessage(message.data)
        if (parsed === null) return
        switch (parsed.type) {
          case 'hodos:init': handlers.onInit?.(parsed); break
          case 'hodos:present': handlers.onPresent(parsed.exercise); break
          case 'hodos:progress': handlers.onProgress?.(parsed.exerciseId, parsed.progress, parsed.message); break
          case 'hodos:result': handlers.onResult?.(parsed); break
          case 'hodos:block': handlers.onBlock?.(parsed.block); break
          case 'hodos:lock': handlers.onLock?.(parsed.locked); break
          case 'hodos:clear': handlers.onClear?.(); break
        }
      }
      port.postMessage({ type: 'hodos:ready', protocol: RENDERER_PROTOCOL })
      resolve({
        respond(exerciseId, response) {
          port.postMessage({ type: 'hodos:response', exerciseId, response })
        },
        resize(height) {
          port.postMessage({ type: 'hodos:resize', height })
        },
      })
    })
  })
}

export type { RendererCapability }
