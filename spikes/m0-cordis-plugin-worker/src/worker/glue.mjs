// Runtime-neutral plugin-worker glue. No imports, no host globals: it runs unchanged in Bun, Node, QuickJS, isolated-vm and workerd.
// createHandler(pluginNamespace) returns handle(requestJson) -> Promise<responseJson>, the whole JSON-in/JSON-out RPC surface:
//   {"id":1,"op":"load","config":{}}                       -> {"id":1,"ok":true,"result":<manifest>}
//   {"id":2,"op":"call","hook":"block:position#validate","args":[node,vctx]} -> {"id":2,"ok":true,"result":<json>}
// `apply(ctx)` runs HERE with a recording facade: functions stay in this runtime, only data (the manifest) leaves.

export function createHandler(plugin) {
  const hooks = new Map()
  const disposers = []
  const manifest = { name: plugin.name, blocks: [], layouts: [], exerciseKinds: [], presets: [] }

  function record(listName, idPrefix, spec) {
    const id = idPrefix + ':' + spec.name
    const data = {}
    const names = []
    for (const [key, value] of Object.entries(spec)) {
      if (typeof value === 'function') { hooks.set(id + '#' + key, value); names.push(key) }
      else if (key === 'fallback' && value && typeof value.text === 'function') {
        hooks.set(id + '#fallback.text', value.text); names.push('fallback.text'); data.fallback = { mode: value.mode }
      } else data[key] = value
    }
    const entry = { id, ...data, hooks: names }
    manifest[listName].push(entry)
    const dispose = () => {
      const i = manifest[listName].indexOf(entry)
      if (i >= 0) manifest[listName].splice(i, 1)
      for (const n of names) hooks.delete(id + '#' + n)
    }
    disposers.push(dispose)
    return dispose
  }

  const ctx = {
    lesson: { block: (s) => record('blocks', 'block', s), layout: (s) => record('layouts', 'layout', s) },
    exercise: { kind: (s) => record('exerciseKinds', 'exercise', s) },
    pedagogy: { preset: (s) => record('presets', 'preset', s) },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return d || (() => {}) },
  }

  let loaded = false
  async function handle(requestJson) {
    let req
    try { req = JSON.parse(requestJson) } catch (e) { return JSON.stringify({ id: null, ok: false, error: { name: 'ProtocolError', message: 'bad json' } }) }
    try {
      if (req.op === 'load') {
        if (!loaded) { loaded = true; await plugin.apply(ctx, req.config) }
        return JSON.stringify({ id: req.id, ok: true, result: manifest })
      }
      if (req.op === 'call') {
        const fn = hooks.get(req.hook)
        if (!fn) return JSON.stringify({ id: req.id, ok: false, error: { name: 'NoSuchHook', message: String(req.hook) } })
        const out = await fn(...(req.args || []))
        return JSON.stringify({ id: req.id, ok: true, result: out === undefined ? null : out })
      }
      if (req.op === 'dispose') { while (disposers.length) await disposers.pop()(); loaded = false; return JSON.stringify({ id: req.id, ok: true, result: null }) }
      return JSON.stringify({ id: req.id, ok: false, error: { name: 'ProtocolError', message: 'unknown op ' + req.op } })
    } catch (e) {
      return JSON.stringify({ id: req.id, ok: false, error: { name: String((e && e.name) || 'Error'), message: String((e && e.message) || e) } })
    }
  }
  return handle
}
