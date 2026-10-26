// Grader and item validator of the "Binary numbers" example plugin.
//
// Hodos never imports this file. It runs inside Hodos's QuickJS sandbox: a
// separate process with no filesystem, network, environment or host objects,
// and with CPU, memory and time limits. It may only define global functions
// that take and return JSON: grade(input) and validateItem(item).

var READ_HELP = 'Each place is worth twice the place to its right: 1, 2, 4, 8, 16 and so on.'

function reverse(text) {
  return String(text).split('').reverse().join('')
}

function bitsOf(text) {
  return String(text).replace(/[\s_]/g, '').replace(/^0b/i, '')
}

function isBinary(text) {
  return /^[01]+$/.test(text)
}

function result(score, feedback, misconceptions) {
  return { score: score, correct: score === 1, skillEvidence: [], misconceptions: misconceptions || [], feedback: feedback }
}

// input: { kind, payload, key, response, mode, skills, attempt }
function grade(input) {
  var payload = input.payload
  var answer = String(input.key.answer)
  var typed = String((input.response && input.response.text) || '').trim()
  if (payload.direction === 'to-binary') {
    var bits = bitsOf(typed)
    if (!isBinary(bits)) return result(0, 'Use only the digits 0 and 1.')
    var value = parseInt(bits, 2)
    var target = parseInt(answer, 2)
    if (value === target) return result(1, 'Correct.')
    if (parseInt(reverse(bits), 2) === target) return result(0, 'Not quite.', ['reversed-bits'])
    return result(0, 'Not quite. ' + READ_HELP)
  }
  if (!/^\d+$/.test(typed)) return result(0, 'Type a whole number, like 12.')
  var number = Number(typed)
  var shown = bitsOf(payload.value)
  if (number === Number(answer)) return result(1, 'Correct.')
  if (number === parseInt(reverse(shown), 2)) return result(0, 'Not quite.', ['reversed-bits'])
  if (typed === shown) return result(0, 'Not quite.', ['read-as-decimal'])
  if (number === shown.split('').filter(function (b) { return b === '1' }).length) return result(0, 'Not quite.', ['counted-ones'])
  return result(0, 'Not quite. ' + READ_HELP)
}

// item: a whole exercise item. Returns a list of { severity, code, message }.
function validateItem(item) {
  var p = item.payload
  var answer = String(item.key.answer)
  var out = []
  var error = function (code, message) { out.push({ severity: 'error', code: code, message: message }) }
  if (p.direction === 'to-binary') {
    if (!/^\d+$/.test(p.value)) error('binary/value', 'value must be a whole number written in decimal')
    else if (!isBinary(answer) || parseInt(answer, 2) !== Number(p.value)) error('binary/key', 'the key is not the binary form of the value')
    else if (answer.length > 1 && answer.charAt(0) === '0') error('binary/key', 'write the key without leading zeros')
  } else {
    if (!isBinary(bitsOf(p.value))) error('binary/value', 'value must be written with 0s and 1s')
    else if (!/^\d+$/.test(answer) || parseInt(bitsOf(p.value), 2) !== Number(answer)) error('binary/key', 'the key is not the decimal value of the binary number')
  }
  if (/^\d{2,}$/.test(answer) && new RegExp('(^|[^0-9])' + answer + '([^0-9]|$)').test(String(p.prompt))) error('binary/answer-in-prompt', 'the prompt contains the answer')
  return out
}
