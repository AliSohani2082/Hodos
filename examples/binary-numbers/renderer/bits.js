// Renderer of the "Binary numbers" example plugin: place-value boxes.
//
// Hodos serves this directory into a sandboxed iframe (opaque origin, scripts
// only from here, no network) and hands it one MessagePort. This file speaks
// the renderer protocol directly, without the SDK helper, to show it at the
// wire level: it accepts the port only from its parent window, checks every
// message before using it, and builds the page with DOM APIs and textContent.
// It only displays; the learner answers in the workspace's own form.
(function () {
  'use strict'
  var PROTOCOL = 1
  var root = document.getElementById('root')
  var port = null

  function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  // A row of place values over a row of bits; value null leaves the bits empty.
  function boxes(value, width) {
    var table = el('table', 'bits')
    var places = el('tr', 'places')
    var bits = el('tr', 'values')
    var spoken = []
    for (var i = width - 1; i >= 0; i--) {
      var place = Math.pow(2, i)
      places.appendChild(el('th', '', String(place)))
      var bit = value === null ? '' : String(Math.floor(value / place) % 2)
      bits.appendChild(el('td', bit === '1' ? 'one' : '', bit))
      spoken.push(value === null ? String(place) : place + ': ' + bit)
    }
    table.setAttribute('aria-label', (value === null ? 'Place values ' : 'Place values and bits: ') + spoken.join(', '))
    table.appendChild(places)
    table.appendChild(bits)
    return table
  }

  function widthFor(value) {
    return value > 15 ? 8 : 4
  }

  function present(exercise) {
    var p = exercise.payload
    if (!isObject(p) || typeof p.prompt !== 'string' || typeof p.value !== 'string') return
    var nodes = [el('p', 'prompt', p.prompt)]
    if (p.direction === 'to-decimal' && /^[01]{1,8}$/.test(p.value)) {
      var value = parseInt(p.value, 2)
      nodes.push(boxes(value, Math.max(p.value.length > 4 ? 8 : 4, widthFor(value))))
    } else if (p.direction === 'to-binary' && /^[0-9]{1,3}$/.test(p.value) && Number(p.value) <= 255) {
      // Empty boxes as a scaffold; the bits are the learner's to find.
      nodes.push(boxes(null, widthFor(Number(p.value))))
    }
    root.replaceChildren.apply(root, nodes)
  }

  function block(node) {
    var a = node.attributes
    if (node.type !== 'binary-bits' || !isObject(a)) return
    var value = a.value
    if (typeof value !== 'number' || value !== Math.floor(value) || value < 0 || value > 255) return
    root.replaceChildren(boxes(value, a.bits === 8 ? 8 : widthFor(value)))
  }

  function resize() {
    if (port !== null) port.postMessage({ type: 'hodos:resize', height: Math.ceil(document.documentElement.scrollHeight) })
  }

  function onHostMessage(event) {
    var m = event.data
    if (!isObject(m) || typeof m.type !== 'string') return
    if (m.type === 'hodos:init') {
      if (m.colorScheme === 'dark' || m.colorScheme === 'light') document.documentElement.setAttribute('data-theme', m.colorScheme)
    } else if (m.type === 'hodos:present' && isObject(m.exercise)) {
      present(m.exercise)
    } else if (m.type === 'hodos:block' && isObject(m.block) && typeof m.block.type === 'string') {
      block(m.block)
    } else if (m.type === 'hodos:clear') {
      root.replaceChildren()
    }
    // hodos:result, hodos:progress and hodos:lock change nothing in a display-only renderer.
    resize()
  }

  window.addEventListener('message', function (event) {
    // The port comes once, from the workspace that embeds this frame.
    if (port !== null || event.source !== window.parent) return
    var m = event.data
    if (!isObject(m) || m.type !== 'hodos:connect' || m.protocol !== PROTOCOL || event.ports.length !== 1) return
    port = event.ports[0]
    port.addEventListener('message', onHostMessage)
    port.start()
    port.postMessage({ type: 'hodos:ready', protocol: PROTOCOL })
  })
  new ResizeObserver(resize).observe(document.body)
})()
