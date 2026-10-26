/**
 * Structured errors and diagnostics for the plugin contract.
 * @module @hodos/plugin-sdk/errors
 */

/** Severity of a validation finding. */
export type DiagnosticSeverity = 'error' | 'warning'

/** One validation finding, attributable to a path, item or lesson node. */
export interface Diagnostic {
  readonly severity: DiagnosticSeverity
  /** Stable machine-readable code, namespaced by its producer (`chess/illegal-fen`). */
  readonly code: string
  /** Human-readable explanation. Must never contain answer keys. */
  readonly message: string
  /** JSON pointer or dotted path to the offending field, when known. */
  readonly path?: string
  /** Lesson node or exercise item id, when the finding is about one. */
  readonly target?: string
}

/** Error codes raised by the SDK and by hosts that implement it. */
export type HodosPluginErrorCode =
  | 'INVALID_MANIFEST'
  | 'INCOMPATIBLE_CORE'
  | 'UNDECLARED_CAPABILITY'
  | 'DUPLICATE_REGISTRATION'
  | 'INVALID_SCHEMA'
  | 'INVALID_REGISTRATION'
  | 'INVALID_CONTENT'
  | 'REGISTRATION_FAILED'

/** Error raised when a plugin violates the contract. */
export class HodosPluginError extends Error {
  override readonly name = 'HodosPluginError'

  /**
   * @param code - stable error code.
   * @param message - human-readable explanation.
   * @param diagnostics - individual findings, when the error aggregates several.
   */
  constructor(
    readonly code: HodosPluginErrorCode,
    message: string,
    readonly diagnostics: readonly Diagnostic[] = [],
  ) {
    super(message)
  }
}

/**
 * Whether any finding is an error.
 * @param diagnostics - findings to inspect.
 * @returns true when at least one has severity `error`.
 */
export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some(d => d.severity === 'error')
}

/**
 * Format findings as one line each, for logs and tool results.
 * @param diagnostics - findings to format.
 * @returns newline-separated text.
 */
export function formatDiagnostics(diagnostics: readonly Diagnostic[]): string {
  return diagnostics
    .map(d => `${d.severity} ${d.code}${d.path ? ` at ${d.path}` : ''}${d.target ? ` [${d.target}]` : ''}: ${d.message}`)
    .join('\n')
}
