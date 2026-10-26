/**
 * `hodos`: command-line tools for course authors.
 *
 *   hodos course guide [--no-schemas]            the authoring guide for the installed environments
 *   hodos course validate FILE                    validate a course file (exit code 1 on errors)
 *   hodos course submit FILE [--data-dir DIR]     validate, then place it in the course inbox
 *   hodos course status [--data-dir DIR]          what the inbox imported or rejected
 *
 * A submitted course is only a proposal: the running Hodos service validates
 * it again and stores it as a draft, and the learner approves or rejects it in
 * the workspace. The tool reads and writes local files only — no network, no
 * credentials, no model calls; whoever writes the course (a person, or Claude
 * Code under its own login) does so outside Hodos.
 * @module @hodos/dsh/cli
 */
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { loadDeclarativePlugin, PluginRegistry, SandboxRunner, authoringGuide, validateCourse } from '@hodos/core'
import { isCourse, validateCourseShape, type CourseSpec, type Diagnostic, type HodosEnvironmentPlugin } from '@hodos/plugin-sdk'
import { BUILT_IN_ENVIRONMENTS } from './config.js'
import { INBOX_DIR, MAX_INBOX_FILE_BYTES } from './inbox.js'

/** Environment packages loaded when installed (the reviewed built-ins). */
export const ENVIRONMENT_PACKAGES: readonly string[] = ['@hodos/chess', '@hodos/language', '@hodos/code', '@hodos/math']

/** Input and output of one CLI run. */
export interface CliIo {
  readonly out: (text: string) => void
  readonly err: (text: string) => void
  readonly env: Readonly<Record<string, string | undefined>>
  readonly cwd: string
  /** Built-in environment plugins; defaults to importing {@link ENVIRONMENT_PACKAGES}. */
  readonly environments?: () => Promise<HodosEnvironmentPlugin[]>
  readonly now?: () => Date
}

const USAGE = `Usage:
  hodos course guide [--no-schemas] [--plugin-dir DIR]...
  hodos course validate FILE [--plugin-dir DIR]...
  hodos course submit FILE [--data-dir DIR] [--plugin-dir DIR]...
  hodos course status [--data-dir DIR]

--data-dir defaults to $HODOS_DATA_DIR, else $DSH_HOME/hodos, else ~/.dsh/hodos
(the default dataDir of the Hodos DeepSeek Harness bundle).`

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined
}

/**
 * The Hodos data directory the inbox lives in.
 * @param flag - `--data-dir`, if given.
 * @param env - environment variables.
 * @param cwd - base for relative paths.
 */
export function resolveDataDir(flag: string | undefined, env: Readonly<Record<string, string | undefined>>, cwd: string): string {
  const explicit = nonEmpty(flag) ?? nonEmpty(env.HODOS_DATA_DIR)
  if (explicit !== undefined) return resolve(cwd, explicit.replace(/^~(?=$|[\\/])/, homedir()))
  const dshHome = nonEmpty(env.DSH_HOME)
  return dshHome === undefined ? join(homedir(), '.dsh', 'hodos') : join(resolve(cwd, dshHome.replace(/^~(?=$|[\\/])/, homedir())), 'hodos')
}

function isFactory(value: unknown): value is () => unknown {
  return typeof value === 'function'
}

function isEnvironmentPlugin(value: unknown): value is HodosEnvironmentPlugin {
  return typeof value === 'object' && value !== null && 'manifest' in value && 'register' in value && typeof value.register === 'function'
}

async function importEnvironments(io: CliIo): Promise<HodosEnvironmentPlugin[]> {
  const plugins: HodosEnvironmentPlugin[] = []
  for (const name of ENVIRONMENT_PACKAGES) {
    let mod: unknown
    try {
      mod = await import(name)
    } catch (error) {
      const missing = error instanceof Error && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes(name)
      if (!missing) io.err(`warning: ${name} is installed but failed to load: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const create = typeof mod === 'object' && mod !== null && 'createPlugin' in mod ? mod.createPlugin : undefined
    const plugin = isFactory(create) ? create() : undefined
    if (isEnvironmentPlugin(plugin)) plugins.push(plugin)
    else io.err(`warning: ${name} does not export createPlugin()`)
  }
  return plugins
}

async function openRegistry(io: CliIo, pluginDirs: readonly string[]): Promise<{ registry: PluginRegistry; dispose: () => void }> {
  const sandbox = new SandboxRunner()
  const registry = new PluginRegistry({
    sandbox,
    logger: { info: () => undefined, warn: m => io.err(`warning: ${m}`), error: m => io.err(`error: ${m}`) },
  })
  try {
    for (const plugin of await (io.environments ?? (() => importEnvironments(io)))()) {
      // Same trust rule as the host: only the reviewed built-ins run in-process validators.
      await registry.register(plugin, { trusted: BUILT_IN_ENVIRONMENTS.includes(plugin.manifest.id) })
    }
    for (const dir of pluginDirs) {
      const plugin = await loadDeclarativePlugin(resolve(io.cwd, dir))
      await registry.register(plugin, { trusted: false, declarative: true })
    }
  } catch (error) {
    sandbox.dispose()
    throw error
  }
  return { registry, dispose: () => sandbox.dispose() }
}

async function readCourseFile(path: string): Promise<{ value: unknown } | { problem: string }> {
  const info = await stat(path).catch(() => null)
  if (info === null || !info.isFile()) return { problem: `${path} is not a readable file` }
  if (info.size > MAX_INBOX_FILE_BYTES) return { problem: `${path} is larger than ${MAX_INBOX_FILE_BYTES} bytes` }
  try {
    return { value: JSON.parse(await readFile(path, 'utf8')) }
  } catch (error) {
    return { problem: `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
}

function printFindings(io: CliIo, findings: readonly Diagnostic[]): void {
  for (const f of findings) {
    const write = f.severity === 'error' ? io.err : io.out
    write(`${f.severity}: ${f.code}: ${f.message}${f.target === undefined ? '' : ` [${f.target}]`}`)
  }
}

/** Validate a course file; returns the course when it has no errors. */
async function check(io: CliIo, file: string, registry: PluginRegistry): Promise<CourseSpec | null> {
  const read = await readCourseFile(resolve(io.cwd, file))
  if ('problem' in read) {
    io.err(`error: ${read.problem}`)
    return null
  }
  const course = read.value
  if (!isCourse(course)) {
    const shape = validateCourseShape(course)
    printFindings(io, shape)
    io.err(`${shape.length} error(s): the file does not have the shape of a course (see \`hodos course guide\`).`)
    return null
  }
  // Authoring is held to the shipped-content standard: practice and checkpoint coverage are required.
  const findings = await validateCourse(course, registry, { requireCoverage: true })
  if (course.items.some(i => i.provenance !== undefined)) {
    findings.push({ severity: 'warning', code: 'course/provenance-ignored', message: 'item provenance is set by Hodos on import; the provenance fields in this file are replaced' })
  }
  printFindings(io, findings)
  const errors = findings.filter(f => f.severity === 'error').length
  const warnings = findings.length - errors
  io.out(`${course.id}@${course.version}: ${errors} error(s), ${warnings} warning(s); ${course.skills.length} skills, ${course.lessons.length} lessons, ${course.items.length} items.`)
  return errors === 0 ? course : null
}

function fileSafe(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '-')
}

/** File names in a directory, newest first (names start with the course id and end with a timestamp). */
async function newestFirst(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [] as string[])).toSorted().toReversed()
}

async function submit(io: CliIo, course: CourseSpec, file: string, dataDir: string): Promise<string> {
  const inbox = join(dataDir, INBOX_DIR)
  await mkdir(inbox, { recursive: true, mode: 0o700 })
  const stamp = (io.now?.() ?? new Date()).getTime()
  const name = `${fileSafe(course.id)}@${fileSafe(course.version)}-${stamp}.json`
  const target = join(inbox, name)
  // Write then rename, so the service never reads a half-written file (it skips *.tmp).
  await writeFile(`${target}.tmp`, await readFile(resolve(io.cwd, file)), { mode: 0o600 })
  await rename(`${target}.tmp`, target)
  return target
}

async function status(io: CliIo, dataDir: string): Promise<void> {
  const inbox = join(dataDir, INBOX_DIR)
  const pending = (await newestFirst(inbox)).filter(n => n.endsWith('.json'))
  const imported = (await newestFirst(join(inbox, 'imported'))).filter(n => n.endsWith('.json')).slice(0, 10)
  const rejected = (await newestFirst(join(inbox, 'rejected'))).filter(n => n.endsWith('.json')).slice(0, 10)
  io.out(`Course inbox: ${inbox}`)
  io.out(pending.length === 0 ? 'Waiting: none.' : `Waiting (imported while DeepSeek Harness runs with Hodos): ${pending.join(', ')}`)
  io.out(imported.length === 0 ? 'Imported: none yet.' : `Imported as drafts (approve them in the Hodos workspace): ${imported.join(', ')}`)
  if (rejected.length === 0) io.out('Rejected: none.')
  for (const name of rejected) {
    const report = await readFile(join(inbox, 'rejected', `${name}.errors.txt`), 'utf8').catch(() => '')
    io.out(`Rejected: ${name}`)
    for (const line of report.split('\n').filter(l => l.startsWith('- ')).slice(0, 20)) io.out(`  ${line}`)
  }
}

/**
 * Run the CLI.
 * @param argv - arguments after the program name.
 * @param io - input/output and environment.
 * @returns the process exit code.
 */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        'data-dir': { type: 'string' },
        'plugin-dir': { type: 'string', multiple: true },
        'no-schemas': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    })
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`)
    return 2
  }
  const [group, command, file] = parsed.positionals
  if (parsed.values.help) {
    io.out(USAGE)
    return 0
  }
  if (group !== 'course' || command === undefined) {
    io.err(USAGE)
    return 2
  }
  const dataDir = resolveDataDir(parsed.values['data-dir'], io.env, io.cwd)
  if (command === 'status') {
    await status(io, dataDir)
    return 0
  }
  if (!['guide', 'validate', 'submit'].includes(command)) {
    io.err(`unknown command: course ${command}\n\n${USAGE}`)
    return 2
  }
  if (command !== 'guide' && file === undefined) {
    io.err(`course ${command} needs a FILE\n\n${USAGE}`)
    return 2
  }
  const { registry, dispose } = await openRegistry(io, parsed.values['plugin-dir'] ?? [])
  try {
    if (registry.environments().length === 0) io.err('warning: no Hodos environment is installed (for example @hodos/chess); only core lesson tags are available.')
    if (command === 'guide') {
      io.out(authoringGuide(registry, { schemas: !parsed.values['no-schemas'] }))
      return 0
    }
    const course = await check(io, file ?? '', registry)
    if (course === null) return 1
    if (command === 'validate') return 0
    const target = await submit(io, course, file ?? '', dataDir)
    io.out(`Submitted ${course.id}@${course.version} to ${target}.`)
    io.out('Hodos imports it within a few seconds while DeepSeek Harness runs with Hodos (or when it next starts) and validates it again.')
    io.out('Then open the Hodos workspace in DeepSeek Harness: the course appears under "Proposed courses" to review and approve. Check the import with `hodos course status`.')
    return 0
  } finally {
    dispose()
  }
}

/**
 * Run with the real process streams and environment.
 * @param argv - arguments after the program name.
 * @returns the exit code.
 */
export function runCli(argv: readonly string[]): Promise<number> {
  return main(argv, {
    out: text => { process.stdout.write(`${text}\n`) },
    err: text => { process.stderr.write(`${text}\n`) },
    env: process.env,
    cwd: process.cwd(),
  })
}
