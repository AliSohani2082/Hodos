/**
 * The environment plugins Hodos trusts by default. Kept apart from the
 * configuration schema so the `hodos` command, which runs outside DeepSeek
 * Harness, needs none of the Harness's runtime packages.
 * @module @hodos/dsh/trust
 */

/** Environment plugins whose in-process hooks Hodos runs (the shipped, reviewed packages). */
export const BUILT_IN_ENVIRONMENTS: readonly string[] = ['hodos-chess', 'hodos-language', 'hodos-code', 'hodos-math']
