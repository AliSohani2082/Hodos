// Independent account-level guard. The local ledger reserves before calls; credits detects other account spend.
import { CREDIT_BASELINE_USD, CREDIT_LIMIT_USD } from './spend.ts'

export class CreditLimitError extends Error {
  constructor(message: string, readonly requestStarted = false) { super(message); this.name = 'CreditLimitError' }
}

export class CreditGuard {
  constructor(private readonly apiKey: string, private readonly fetcher: typeof fetch = fetch) {}

  async totalUsage(): Promise<number> {
    const response = await this.fetcher('https://openrouter.ai/api/v1/credits', {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    })
    if (!response.ok) throw new CreditLimitError(`Credit check failed (HTTP ${response.status})`)
    const json = await response.json() as { data?: { total_usage?: number } }
    const usage = Number(json.data?.total_usage)
    if (!Number.isFinite(usage) || usage < 0) throw new CreditLimitError('Credit check returned invalid total_usage')
    return usage
  }

  async keyRemaining(): Promise<number> {
    const response = await this.fetcher('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    })
    if (!response.ok) throw new CreditLimitError(`Key budget check failed (HTTP ${response.status})`)
    const json = await response.json() as { data?: { effective_budget?: { remaining_usd?: number }; limit_remaining?: number | null } }
    const values = [json.data?.effective_budget?.remaining_usd, json.data?.limit_remaining]
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    return values.length ? Math.min(...values) : Infinity
  }

  async assertAvailable(reservationUSD: number, requestStarted = false): Promise<number> {
    let usage: number
    let keyRemaining: number
    try { [usage, keyRemaining] = await Promise.all([this.totalUsage(), this.keyRemaining()]) }
    catch (error) {
      if (error instanceof CreditLimitError) throw new CreditLimitError(error.message, requestStarted)
      throw new CreditLimitError('Credit check failed', requestStarted)
    }
    if (usage + reservationUSD > CREDIT_LIMIT_USD + 1e-8)
      throw new CreditLimitError(`Account usage delta $${(usage - CREDIT_BASELINE_USD).toFixed(4)} leaves less than the reserved $${reservationUSD.toFixed(4)} of the $19.00 limit`, requestStarted)
    if (keyRemaining < reservationUSD - 1e-8)
      throw new CreditLimitError(`OpenRouter key budget has $${keyRemaining.toFixed(4)} remaining, below the reserved $${reservationUSD.toFixed(4)}`, requestStarted)
    return usage
  }
}
