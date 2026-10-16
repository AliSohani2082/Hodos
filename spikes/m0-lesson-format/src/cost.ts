// Published OpenRouter rates are used only to reserve a conservative pre-call bound, never as measured cost.
// Actual per-call cost is taken from OpenRouter's usage.cost response field.
import type { Usage } from './score.ts'
import type { Model } from './types.ts'

export interface Price {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

export const RESERVE_PRICES: Record<Model, Price> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
}
export const RESERVE_MARGIN = 1.15

/** Output tokens include thinking tokens, which bill as output. */
export function costOf(model: Model, u: Usage): number {
  if (u.costUSD !== undefined) return u.costUSD
  const p = RESERVE_PRICES[model]
  return (u.input * p.input + u.output * p.output + u.cacheWrite * p.cacheWrite + u.cacheRead * p.cacheRead) / 1e6
}

/** Upper bound for one call: every input token billed at the cache-write rate, and max_tokens of output. */
export function worstCase(model: Model, inputTokensUpperBound: number, maxTokens: number): number {
  const p = RESERVE_PRICES[model]
  return ((inputTokensUpperBound * Math.max(p.input, p.cacheWrite) + maxTokens * p.output) / 1e6) * RESERVE_MARGIN
}

/**
 * Never lets reserved + spent exceed the cap. A call is only sent after reserving its worst case, so the cap holds
 * even with concurrent calls in flight (the price is that the last few calls near the cap run one at a time).
 */
export class Budget {
  spent = 0
  private inflight = 0
  constructor(readonly capUSD: number) {}

  tryReserve(worst: number): boolean {
    if (this.spent + this.inflight + worst > this.capUSD) return false
    this.inflight += worst
    return true
  }
  settle(worst: number, actual: number) {
    this.inflight = Math.max(0, this.inflight - worst)
    this.spent += actual
  }
  release(worst: number) {
    this.inflight = Math.max(0, this.inflight - worst)
  }
  get remaining() {
    return this.capUSD - this.spent - this.inflight
  }
}
