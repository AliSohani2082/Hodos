/**
 * The environment plugin manifest and its validation.
 * @module @hodos/plugin-sdk/manifest
 */
import type { Diagnostic } from './errors.js'
import type { JsonSchema } from './json.js'
import { RENDERER_CAPABILITIES, type RendererCapability } from './protocol.js'
import { compileSchema } from './schema.js'
import { isSemver, satisfiesCore } from './version.js'

/** Capability ids a plugin may register. Registering anything undeclared is rejected. */
export interface ManifestCapabilities {
  /** Environment ids (renderer families) the plugin provides, e.g. `chess.board`. */
  readonly environments?: readonly string[]
  readonly lessonBlocks?: readonly string[]
  readonly exerciseKinds?: readonly string[]
  readonly graders?: readonly string[]
  readonly presets?: readonly string[]
  readonly renderers?: readonly string[]
  readonly contentPacks?: readonly string[]
  readonly generators?: readonly string[]
}

/** Static description of an environment plugin (spec §9). */
export interface HodosEnvironmentManifest {
  /** Lowercase id, e.g. `hodos-chess`. */
  readonly id: string
  /** Plugin version (semver). */
  readonly version: string
  readonly displayName: string
  readonly description?: string
  /** Range of `@hodos/core` plugin API versions supported, e.g. `^0.1.0`. */
  readonly requiresCore: string
  /** SDK version the plugin was built with. */
  readonly sdkVersion: string
  /** SPDX license expression. */
  readonly license?: string
  readonly capabilities: ManifestCapabilities
  /** Renderer capabilities requested; shown to the user and enforced by the host. */
  readonly rendererPermissions?: readonly RendererCapability[]
}

const ID = { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{1,63}$' } as const
const ID_LIST = { type: 'array', items: ID, uniqueItems: true, maxItems: 64 } as const

/** JSON Schema of {@link HodosEnvironmentManifest}. */
export const MANIFEST_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'version', 'displayName', 'requiresCore', 'sdkVersion', 'capabilities'],
  properties: {
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,63}$' },
    version: { type: 'string', minLength: 5, maxLength: 64 },
    displayName: { type: 'string', minLength: 1, maxLength: 80 },
    description: { type: 'string', maxLength: 500 },
    requiresCore: { type: 'string', minLength: 1, maxLength: 64 },
    sdkVersion: { type: 'string', minLength: 5, maxLength: 64 },
    license: { type: 'string', maxLength: 64 },
    capabilities: {
      type: 'object',
      additionalProperties: false,
      properties: {
        environments: ID_LIST,
        lessonBlocks: ID_LIST,
        exerciseKinds: ID_LIST,
        graders: ID_LIST,
        presets: { type: 'array', items: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{1,63}@[0-9]+$' }, uniqueItems: true },
        renderers: ID_LIST,
        contentPacks: ID_LIST,
        generators: ID_LIST,
      },
    },
    rendererPermissions: { type: 'array', items: { enum: [...RENDERER_CAPABILITIES] }, uniqueItems: true },
  },
}

const validateShape = compileSchema(MANIFEST_SCHEMA, 'manifest/schema')

/**
 * Validate a manifest's shape, versions and compatibility with a host.
 * @param manifest - candidate manifest (untrusted).
 * @param hostApiVersion - the host's plugin API version; omit to skip the compatibility check.
 * @returns findings; empty when the manifest is valid and compatible.
 */
export function validateManifest(manifest: unknown, hostApiVersion?: string): Diagnostic[] {
  const shape = validateShape(manifest)
  if (shape.length > 0) return [...shape]
  const m = manifest as HodosEnvironmentManifest // shape validated above
  const out: Diagnostic[] = []
  if (!isSemver(m.version)) out.push({ severity: 'error', code: 'manifest/version', message: `version "${m.version}" is not semver`, path: '/version' })
  if (!isSemver(m.sdkVersion)) out.push({ severity: 'error', code: 'manifest/sdk-version', message: `sdkVersion "${m.sdkVersion}" is not semver`, path: '/sdkVersion' })
  if (hostApiVersion !== undefined && !satisfiesCore(hostApiVersion, m.requiresCore)) {
    out.push({
      severity: 'error',
      code: 'manifest/incompatible-core',
      message: `plugin requires core ${m.requiresCore}; host provides ${hostApiVersion}`,
      path: '/requiresCore',
    })
  }
  return out
}
