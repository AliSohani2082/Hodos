/**
 * A minimal UCI client for an external chess engine (e.g. Stockfish). The
 * engine is a separate program the host configures (`stockfishPath`); it is
 * started without a shell and with an empty environment, one analysis runs
 * at a time, and every analysis has a deadline after which the engine is
 * killed. Hodos never ships or links the engine.
 * @module @hodos/chess/engine
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/** A score from the side to move's point of view. */
export type EngineScore = { readonly cp: number } | { readonly mate: number }

/** One principal variation. */
export interface EngineLine {
  readonly multipv: number
  readonly depth: number
  readonly score: EngineScore
  /** Moves in UCI notation; the first is the line's move. */
  readonly pv: readonly string[]
}

/** Analysis result. */
export interface EngineAnalysis {
  readonly bestmove: string
  readonly lines: readonly EngineLine[]
}

/** Analysis options. */
export interface AnalyseOptions {
  readonly depth?: number
  readonly movetimeMs?: number
  readonly multiPv?: number
  /** Hard deadline for the whole request, ms. */
  readonly timeoutMs?: number
}

/**
 * Convert a score to centipawns for comparisons (mates map to ±100 000 minus distance).
 * @param score - engine score.
 * @returns comparable centipawns.
 */
export function scoreCp(score: EngineScore): number {
  if ('cp' in score) return score.cp
  return score.mate > 0 ? 100_000 - score.mate : -100_000 - score.mate
}

/**
 * Parse one `info` line.
 * @param line - raw engine output.
 * @returns the variation, or null for other info lines.
 */
export function parseInfo(line: string): EngineLine | null {
  if (!line.startsWith('info ') || !line.includes(' pv ')) return null
  const depth = /\bdepth (\d+)/.exec(line)
  const multipv = /\bmultipv (\d+)/.exec(line)
  const cp = /\bscore cp (-?\d+)/.exec(line)
  const mate = /\bscore mate (-?\d+)/.exec(line)
  const pv = / pv (.+)$/.exec(line)
  if (depth === null || pv === null || (cp === null && mate === null)) return null
  if (/\b(lowerbound|upperbound)\b/.test(line)) return null
  return {
    depth: Number(depth[1]),
    multipv: multipv === null ? 1 : Number(multipv[1]),
    score: cp !== null ? { cp: Number(cp[1]) } : { mate: Number(mate?.[1] ?? 0) },
    pv: (pv[1] ?? '').trim().split(/\s+/),
  }
}

/** A UCI engine process. */
export class UciEngine {
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private waiters: Array<{ match: (line: string) => boolean; resolve: (line: string) => void }> = []
  private queue: Promise<unknown> = Promise.resolve()
  private disposed = false
  private readonly onLine = new Set<(line: string) => void>()

  /** @param path - absolute path of the engine binary. */
  constructor(readonly path: string) {}

  private start(): ChildProcessWithoutNullStreams {
    if (this.child !== null) return this.child
    const child = spawn(this.path, [], { env: {}, stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      let newline = this.buffer.indexOf('\n')
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline).trim()
        this.buffer = this.buffer.slice(newline + 1)
        for (const listener of this.onLine) listener(line)
        const waiter = this.waiters.find(w => w.match(line))
        if (waiter !== undefined) {
          this.waiters = this.waiters.filter(w => w !== waiter)
          waiter.resolve(line)
        }
        newline = this.buffer.indexOf('\n')
      }
    })
    child.on('exit', () => {
      if (this.child === child) this.child = null
    })
    child.on('error', () => {
      if (this.child === child) this.child = null
    })
    this.child = child
    return child
  }

  private send(command: string): void {
    this.start().stdin.write(`${command}\n`)
  }

  private waitFor(match: (line: string) => boolean): Promise<string> {
    return new Promise(resolve => this.waiters.push({ match, resolve }))
  }

  private kill(): void {
    this.child?.kill('SIGKILL')
    this.child = null
    this.waiters = []
    this.buffer = ''
  }

  /**
   * Run one request at a time, killing the engine if it misses the deadline.
   * @param timeoutMs - deadline for this request.
   * @param work - the request.
   */
  private exclusive<T>(timeoutMs: number, work: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      if (this.disposed) throw new Error('engine is disposed')
      let timer: NodeJS.Timeout | undefined
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { this.kill(); reject(new Error(`engine missed its ${timeoutMs} ms deadline`)) }, timeoutMs)
      })
      try {
        return await Promise.race([work(), deadline])
      } finally {
        clearTimeout(timer)
      }
    }
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }

  /**
   * The engine's self-reported name (its `id name` line).
   * @param timeoutMs - deadline.
   * @returns e.g. `Stockfish 17.1`, or an empty string when the engine does not say.
   */
  identify(timeoutMs = 10_000): Promise<string> {
    return this.exclusive(timeoutMs, async () => {
      let name = ''
      const collect = (line: string): void => {
        if (line.startsWith('id name ')) name = line.slice('id name '.length).trim()
      }
      this.onLine.add(collect)
      try {
        this.send('uci')
        await this.waitFor(l => l === 'uciok')
      } finally {
        this.onLine.delete(collect)
      }
      return name
    })
  }

  /**
   * Analyse a position.
   * @param fen - position.
   * @param options - depth or move time, number of lines, deadline.
   * @returns the best move and variations (scores from the side to move's view).
   * @throws Error when the engine fails or misses the deadline.
   */
  analyse(fen: string, options: AnalyseOptions = {}): Promise<EngineAnalysis> {
    return this.exclusive(options.timeoutMs ?? 10_000, async () => {
      const lines = new Map<number, EngineLine>()
      const collect = (line: string): void => {
        const info = parseInfo(line)
        if (info !== null) lines.set(info.multipv, info)
      }
      try {
        this.send('uci')
        await this.waitFor(l => l === 'uciok')
        this.send(`setoption name MultiPV value ${Math.max(1, Math.min(5, options.multiPv ?? 1))}`)
        this.send('isready')
        await this.waitFor(l => l === 'readyok')
        this.onLine.add(collect)
        this.send('ucinewgame')
        this.send(`position fen ${fen}`)
        this.send(options.movetimeMs !== undefined ? `go movetime ${Math.round(options.movetimeMs)}` : `go depth ${Math.max(1, Math.min(30, options.depth ?? 14))}`)
        const best = await this.waitFor(l => l.startsWith('bestmove'))
        return { bestmove: best.split(/\s+/)[1] ?? '(none)', lines: [...lines.values()].toSorted((a, b) => a.multipv - b.multipv) }
      } finally {
        this.onLine.delete(collect)
      }
    })
  }

  /** Stop the engine process. */
  dispose(): void {
    this.disposed = true
    if (this.child !== null) {
      this.child.stdin.write('quit\n')
      this.kill()
    }
  }
}
