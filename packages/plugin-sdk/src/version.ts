/**
 * Versioning of the plugin contract.
 *
 * - `SDK_VERSION` is this package's version; plugins record it in `manifest.sdkVersion`.
 * - `CORE_PLUGIN_API_VERSION` is the version of the host-side plugin API that
 *   `@hodos/core` implements. A plugin declares the range it supports in
 *   `manifest.requiresCore`; the host refuses incompatible plugins.
 * @module @hodos/plugin-sdk/version
 */
import semver from 'semver'

/** Version of this SDK. */
export const SDK_VERSION = '0.1.0'

/** Plugin API version implemented by the matching `@hodos/core`. */
export const CORE_PLUGIN_API_VERSION = '0.1.0'

/**
 * Whether a host API version satisfies a plugin's declared range.
 * Prerelease host versions are compared as releases of the same version.
 * @param hostVersion - the host's `CORE_PLUGIN_API_VERSION`.
 * @param range - the plugin's `requiresCore` range, e.g. `^0.1.0`.
 * @returns true when compatible; false for an invalid range.
 */
export function satisfiesCore(hostVersion: string, range: string): boolean {
  if (semver.validRange(range) === null) return false
  return semver.satisfies(hostVersion, range, { includePrerelease: true })
}

/**
 * Whether a string is a valid semantic version.
 * @param version - candidate version.
 * @returns true for `1.2.3`, `0.1.0-rc.1` and similar.
 */
export function isSemver(version: string): boolean {
  return semver.valid(version) !== null
}
