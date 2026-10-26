/**
 * Declarative plugins: the untrusted plugin tier. A declarative plugin is a
 * directory containing `hodos-plugin.json` (manifest, exercise kinds, graders,
 * blocks, presets, renderers, content files). Hodos reads it as data and
 * never imports its JavaScript: grader sources run only in the QuickJS
 * sandbox and renderer files only in sandboxed iframes.
 *
 * Every path is resolved inside the plugin directory (symlinks included),
 * and every file has a size cap.
 * @module @hodos/core/registry/declarative
 */
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  compileSchema,
  formatDiagnostics,
  HodosPluginError,
  type ContentPack,
  type ExerciseKindSpec,
  type HodosEnvironmentManifest,
  type HodosEnvironmentPlugin,
  type JsonSchema,
  type JsonValue,
  type LessonBlockSpec,
  type PedagogyPreset,
} from '@hodos/plugin-sdk'
import { genericFallbackText } from './registry.js'

/** File name of the declarative plugin description. */
export const DECLARATIVE_PLUGIN_FILE = 'hodos-plugin.json'

const MAX_DESCRIPTION_BYTES = 1024 * 1024
const MAX_GRADER_BYTES = 512 * 1024
const MAX_CONTENT_BYTES = 8 * 1024 * 1024

const DECLARATIVE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['manifest'],
  properties: {
    manifest: { type: 'object' },
    exerciseKinds: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'environment', 'responseKind', 'interaction', 'grader', 'format', 'payloadSchema', 'keySchema', 'responseSchema'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          environment: { type: 'string' },
          responseKind: { enum: ['choice', 'text', 'moves', 'code', 'number', 'expression', 'structured'] },
          interaction: { enum: ['single', 'stepwise'] },
          grader: { type: 'string' },
          format: {
            type: 'object',
            additionalProperties: false,
            required: ['guessable'],
            properties: { guessable: { type: 'boolean' }, options: { type: 'integer', minimum: 2 } },
          },
          payloadSchema: { type: 'object' },
          keySchema: { type: 'object' },
          responseSchema: { type: 'object' },
          fallbackTemplate: { type: 'string', maxLength: 500 },
        },
      },
    },
    graders: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'kinds', 'method', 'sandbox'],
        properties: {
          id: { type: 'string' },
          kinds: { type: 'array', items: { type: 'string' } },
          method: { enum: ['deterministic', 'oracle', 'engine'] },
          sandbox: { type: 'string' },
        },
      },
    },
    lessonBlocks: { type: 'array', items: { type: 'object' } },
    presets: { type: 'array', items: { type: 'object' } },
    renderers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'environments', 'root', 'entry'],
        properties: {
          id: { type: 'string' },
          environments: { type: 'array', items: { type: 'string' } },
          root: { type: 'string' },
          entry: { type: 'string' },
          capabilities: { type: 'array', items: { enum: ['respond', 'resize', 'speech-synthesis'] } },
        },
      },
    },
    contentPacks: { type: 'array', items: { type: 'string' } },
  },
}

const validateDescription = compileSchema(DECLARATIVE_SCHEMA, 'declarative/schema')

/**
 * Resolve a plugin-relative path, refusing anything outside the directory.
 * @param root - the plugin directory (already real).
 * @param relativePath - path from the description.
 * @returns the real absolute path.
 * @throws {HodosPluginError} `INVALID_CONTENT` for absolute or escaping paths.
 */
async function inside(root: string, relativePath: string): Promise<string> {
  if (isAbsolute(relativePath)) throw new HodosPluginError('INVALID_CONTENT', `path ${relativePath} must be relative to the plugin directory`)
  const real = await realpath(resolve(root, relativePath))
  const rel = relative(root, real)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new HodosPluginError('INVALID_CONTENT', `path ${relativePath} resolves outside the plugin directory`)
  return real
}

async function readCapped(path: string, cap: number): Promise<string> {
  const info = await stat(path)
  if (!info.isFile()) throw new HodosPluginError('INVALID_CONTENT', `${path} is not a file`)
  if (info.size > cap) throw new HodosPluginError('INVALID_CONTENT', `${path} exceeds ${cap} bytes`)
  return readFile(path, 'utf8')
}

function interpolate(template: string, payload: JsonValue): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, field: string) => {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return ''
    const value = payload[field]
    return typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 500) : ''
  })
}

/**
 * Load a declarative plugin directory as data.
 * @param dir - absolute plugin directory.
 * @returns a plugin whose `register` contributes only data and sandboxed sources.
 * @throws {HodosPluginError} `INVALID_CONTENT` for unreadable, oversized,
 *   escaping or schema-invalid files.
 */
export async function loadDeclarativePlugin(dir: string): Promise<HodosEnvironmentPlugin> {
  const root = await realpath(dir)
  const descriptionText = await readCapped(join(root, DECLARATIVE_PLUGIN_FILE), MAX_DESCRIPTION_BYTES)
  let description: unknown
  try {
    description = JSON.parse(descriptionText)
  } catch (error) {
    throw new HodosPluginError('INVALID_CONTENT', `${DECLARATIVE_PLUGIN_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const findings = validateDescription(description)
  if (findings.length > 0) throw new HodosPluginError('INVALID_CONTENT', `${DECLARATIVE_PLUGIN_FILE} rejected:\n${formatDiagnostics(findings)}`, findings)
  // Shape validated by DECLARATIVE_SCHEMA above; nested contracts are checked again at registration.
  const d = description as {
    manifest: HodosEnvironmentManifest
    exerciseKinds?: Array<Omit<ExerciseKindSpec, 'validateItem' | 'fallbackText'> & { fallbackTemplate?: string }>
    graders?: Array<{ id: string; kinds: string[]; method: 'deterministic' | 'oracle' | 'engine'; sandbox: string }>
    lessonBlocks?: Array<Omit<LessonBlockSpec, 'validate' | 'fallbackText'> & { fallbackTemplate?: string }>
    presets?: PedagogyPreset[]
    renderers?: Array<{ id: string; environments: string[]; root: string; entry: string; capabilities?: Array<'respond' | 'resize' | 'speech-synthesis'> }>
    contentPacks?: string[]
  }

  const graders = await Promise.all((d.graders ?? []).map(async g => ({
    id: g.id, kinds: g.kinds, method: g.method,
    sandbox: { source: await readCapped(await inside(root, g.sandbox), MAX_GRADER_BYTES) },
  })))
  const renderers = await Promise.all((d.renderers ?? []).map(async r => ({
    id: r.id, environments: r.environments, root: await inside(root, r.root), entry: r.entry, capabilities: r.capabilities ?? ['respond', 'resize'],
  })))
  const packs = await Promise.all((d.contentPacks ?? []).map(async file => {
    const text = await readCapped(await inside(root, file), MAX_CONTENT_BYTES)
    try {
      return JSON.parse(text) as ContentPack // validated by the course validator before use
    } catch (error) {
      throw new HodosPluginError('INVALID_CONTENT', `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }))

  return {
    manifest: d.manifest,
    register(ctx) {
      for (const g of graders) ctx.registerGrader(g)
      for (const k of d.exerciseKinds ?? []) {
        const { fallbackTemplate, ...spec } = k
        ctx.registerExerciseKind({
          ...spec,
          fallbackText: payload => fallbackTemplate === undefined ? genericFallbackText(spec.title, payload) : interpolate(fallbackTemplate, payload),
        })
      }
      for (const b of d.lessonBlocks ?? []) {
        const { fallbackTemplate, ...spec } = b
        ctx.registerLessonBlock({ ...spec, fallbackText: node => fallbackTemplate === undefined ? `[${spec.name}]` : interpolate(fallbackTemplate, node.attributes) })
      }
      for (const p of d.presets ?? []) ctx.registerPreset(p)
      for (const r of renderers) ctx.registerRenderer(r)
      for (const p of packs) ctx.registerContentPack(p)
    },
  }
}
