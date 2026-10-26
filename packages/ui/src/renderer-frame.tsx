/**
 * Host side of the renderer protocol. Environment renderers are untrusted:
 * they run in `sandbox="allow-scripts"` iframes (opaque origin, no cookies,
 * no access to this page or the DSH API; the server also forces a CSP
 * sandbox with `connect-src 'none'`). The only channel is one MessagePort,
 * and every message is validated with the SDK parser; anything else is dropped.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import {
  parseRendererMessage,
  RENDERER_PROTOCOL,
  type HostToRendererMessage,
  type JsonValue,
  type RendererCapability,
} from '@hodos/plugin-sdk/protocol'
import type { RendererRef } from '@hodos/core'

/** Imperative handle: send a message to the renderer (queued until it is ready). */
export interface RendererHandle {
  post(message: HostToRendererMessage): void
}

interface Props {
  readonly renderer: RendererRef
  readonly environment: string
  readonly title: string
  readonly capabilities: readonly RendererCapability[]
  readonly initialHeight?: number
  /** Called with a validated response for the exercise currently presented. */
  readonly onResponse?: (exerciseId: string, response: JsonValue) => void
  /** Called once the renderer completed the handshake. */
  readonly onReady?: () => void
}

/** Encode each path segment of a renderer entry. */
export function rendererUrl(renderer: RendererRef): string {
  const entry = renderer.entry.split('/').filter(s => s !== '' && s !== '.' && s !== '..').map(encodeURIComponent).join('/')
  return `/hodos/env/${encodeURIComponent(renderer.pluginId)}/${encodeURIComponent(renderer.rendererId)}/${entry}`
}

function colorScheme(): 'light' | 'dark' {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches === true ? 'dark' : 'light'
}

export const RendererFrame = forwardRef<RendererHandle, Props>(function RendererFrame(props, ref) {
  const frame = useRef<HTMLIFrameElement | null>(null)
  const port = useRef<MessagePort | null>(null)
  const ready = useRef(false)
  const queue = useRef<HostToRendererMessage[]>([])
  const [height, setHeight] = useState(props.initialHeight ?? 440)
  const handlers = useRef(props)
  handlers.current = props

  const post = useCallback((message: HostToRendererMessage) => {
    if (port.current !== null && ready.current) port.current.postMessage(message)
    else queue.current.push(message)
  }, [])
  useImperativeHandle(ref, () => ({ post }), [post])

  useEffect(() => () => { port.current?.close() }, [])

  const connect = (): void => {
    const target = frame.current?.contentWindow
    if (target === null || target === undefined) return
    port.current?.close()
    ready.current = false
    const channel = new MessageChannel()
    port.current = channel.port1
    channel.port1.onmessage = event => {
      const message = parseRendererMessage(event.data)
      if (message === null) return
      const current = handlers.current
      switch (message.type) {
        case 'hodos:ready': {
          ready.current = true
          channel.port1.postMessage({
            type: 'hodos:init', protocol: RENDERER_PROTOCOL, environment: current.environment,
            locale: navigator.language, colorScheme: colorScheme(), capabilities: [...current.capabilities],
          } satisfies HostToRendererMessage)
          for (const queued of queue.current.splice(0)) channel.port1.postMessage(queued)
          current.onReady?.()
          break
        }
        case 'hodos:resize':
          if (current.capabilities.includes('resize')) setHeight(Math.min(1200, Math.max(120, message.height)))
          break
        case 'hodos:response':
          if (current.capabilities.includes('respond')) current.onResponse?.(message.exerciseId, message.response)
          break
      }
    }
    // The renderer has an opaque origin, so '*' is the only usable target; the message carries nothing but the port.
    target.postMessage({ type: 'hodos:connect', protocol: RENDERER_PROTOCOL }, '*', [channel.port2])
  }

  return (
    <iframe
      ref={frame}
      className="renderer-frame"
      src={rendererUrl(props.renderer)}
      sandbox="allow-scripts"
      allow=""
      referrerPolicy="no-referrer"
      title={props.title}
      onLoad={connect}
      style={{ height }}
    />
  )
})
