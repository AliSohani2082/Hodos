import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Resolve workspace packages to their TypeScript sources so tests never depend
 * on a prior build. Each package's `exports` entries with a `hodos-source`
 * condition become exact aliases.
 */
function workspaceAliases(): { find: RegExp; replacement: string }[] {
  const roots = ['packages', 'packages/environments', 'examples']
  const aliases: { find: RegExp; replacement: string }[] = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const dir of readdirSync(root)) {
      const manifestPath = join(root, dir, 'package.json')
      if (!existsSync(manifestPath)) continue
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name: string; exports?: Record<string, unknown> }
      for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
        if (typeof target !== 'object' || target === null) continue
        const source = (target as Record<string, unknown>)['hodos-source']
        if (typeof source !== 'string') continue
        const specifier = subpath === '.' ? manifest.name : `${manifest.name}/${subpath.slice(2)}`
        const escaped = specifier.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
        aliases.push({ find: new RegExp(`^${escaped}$`), replacement: resolve(root, dir, source) })
      }
    }
  }
  return aliases
}

export default defineConfig({
  resolve: { alias: workspaceAliases() },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/**/tests/**/*.test.ts', 'examples/**/tests/**/*.test.ts', 'tests/integration/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/*.e2e.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
        },
      },
      {
        // Real-browser and real-host tests (Playwright Chromium; DSH where installed). Run `pnpm build` first.
        extends: true,
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.e2e.test.ts'],
          environment: 'node',
          testTimeout: 180_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
    ],
  },
})
