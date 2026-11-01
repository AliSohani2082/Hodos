/**
 * The code-runner contract. Hodos never runs learner code itself, and this
 * package contains no runner. A host that operates an isolated runner
 * service (ADR-0004) passes an implementation to `createCodePlugin`; only
 * then are code-writing exercises offered. Following ADR-0004 tier 1, the
 * runner receives the learner's source and the inputs only: expected outputs
 * stay in Hodos and are compared outside the sandbox.
 * @module @hodos/code/runner
 */

/** Limits the runner must enforce for each run. */
export interface RunLimits {
  /** Wall-clock time per run, in milliseconds. */
  readonly wallMs: number
  readonly memoryMb: number
  /** Output kept per stream, in bytes; more ends the run with `output-limit`. */
  readonly outputBytes: number
}

/** Limits Hodos asks for. A runner may enforce stricter ones. */
export const DEFAULT_LIMITS: RunLimits = { wallMs: 1000, memoryMb: 256, outputBytes: 16 * 1024 }

/** How one run ended. */
export const RUN_STATUSES = ['ok', 'error', 'timeout', 'memory', 'output-limit'] as const

/** One run status: `error` means the program raised or exited non-zero. */
export type RunStatus = (typeof RUN_STATUSES)[number]

/** One request: run `source` once per input, each run in a fresh sandbox. */
export interface RunRequest {
  readonly language: 'python'
  readonly source: string
  /** Standard input of each run. */
  readonly inputs: readonly string[]
  readonly limits: RunLimits
  /** Aborted when Hodos stops waiting; the runner should stop the runs. */
  readonly signal: AbortSignal
}

/** What one run produced. */
export interface RunOutcome {
  readonly status: RunStatus
  readonly stdout: string
  readonly stderr: string
}

/**
 * An isolated code runner supplied by the host. Implementations must meet
 * {@link RUNNER_REQUIREMENTS}; Hodos cannot verify them and trusts the host
 * that supplies one.
 */
export interface CodeRunner {
  /** How programs are isolated, in a few words (for administrators), e.g. "rootless podman + crun, no network". */
  readonly isolation: string
  /** Languages it runs. */
  readonly languages: readonly string[]
  /** Resolve with one outcome per input, in input order. */
  run(request: RunRequest): Promise<readonly RunOutcome[]>
}

/** What a runner must guarantee before a host may supply it (ADR-0004, PRD EX-5b and DP-3). */
export const RUNNER_REQUIREMENTS: readonly string[] = [
  'Runs every program outside the Hodos and DeepSeek Harness host process, in a fresh sandbox (container or VM) as an unprivileged user.',
  'Gives the program no network, no host filesystem, no host environment variables and no credentials; at most a small private scratch directory.',
  'Enforces the requested wall-time, memory and output limits, plus process-count and disk limits of its own.',
  'Receives only the source and the inputs: expected outputs, hidden tests and reference solutions never enter the sandbox.',
  'Reports outcomes through a channel the program cannot write to, so a program cannot forge its own status.',
]

/** Largest number of runs one grading may ask for. */
export const MAX_RUNS = 13

/**
 * Check a runner's answer. A malformed answer is an error (the attempt is not
 * counted), never a pass.
 * @param outcomes - what the runner resolved with.
 * @param count - number of inputs sent.
 * @param limits - the limits sent; longer output counts as `output-limit`.
 * @returns the outcomes.
 */
export function checkOutcomes(outcomes: unknown, count: number, limits: RunLimits): RunOutcome[] {
  if (!Array.isArray(outcomes) || outcomes.length !== count) throw new Error(`the code runner returned ${Array.isArray(outcomes) ? outcomes.length : 'no'} outcomes for ${count} inputs`)
  return outcomes.map((raw: unknown, i) => {
    if (typeof raw !== 'object' || raw === null) throw new Error(`outcome ${i + 1} is not an object`)
    const status = 'status' in raw ? RUN_STATUSES.find(s => s === raw.status) : undefined
    const stdout = 'stdout' in raw && typeof raw.stdout === 'string' ? raw.stdout : undefined
    const stderr = 'stderr' in raw && typeof raw.stderr === 'string' ? raw.stderr : undefined
    if (status === undefined || stdout === undefined || stderr === undefined) throw new Error(`outcome ${i + 1} is malformed`)
    // Characters are at most 4 bytes; anything longer than the byte limit allows was not cut by the runner.
    const tooLong = stdout.length > limits.outputBytes || stderr.length > limits.outputBytes
    return tooLong ? { status: 'output-limit', stdout: '', stderr: '' } : { status, stdout, stderr }
  })
}

/**
 * Ask a runner for outcomes, waiting at most `budgetMs`. Past the budget the
 * request is aborted and an error is thrown: a runner that does not answer is
 * the host's problem, not a wrong answer.
 * @param runner - the host's runner.
 * @param request - source, inputs and limits.
 * @param budgetMs - total time to wait.
 * @returns the checked outcomes.
 */
export async function runAll(runner: CodeRunner, request: Omit<RunRequest, 'signal'>, budgetMs: number): Promise<RunOutcome[]> {
  if (request.inputs.length > MAX_RUNS) throw new Error(`at most ${MAX_RUNS} runs per grading`)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`the code runner did not answer within ${budgetMs} ms`))
    }, budgetMs)
  })
  try {
    const outcomes = await Promise.race([runner.run({ ...request, signal: controller.signal }), deadline])
    return checkOutcomes(outcomes, request.inputs.length, request.limits)
  } finally {
    clearTimeout(timer)
  }
}
