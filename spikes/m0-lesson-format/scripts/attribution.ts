// Writes fixtures/ATTRIBUTION.md from the committed packs. The pack text is CC BY-SA 4.0 Wikipedia content.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { SourcePack } from '../src/types.ts'

const dir = new URL('../fixtures/packs/', import.meta.url)
const packs: SourcePack[] = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8')))
const lines = [
  '# Attribution for the source packs',
  '',
  'The files in `packs/` contain excerpts of English Wikipedia articles, fetched through the MediaWiki API and cut into chunks without other changes. Wikipedia text is available under the [Creative Commons Attribution-ShareAlike 4.0 licence](https://creativecommons.org/licenses/by-sa/4.0/); authorship is recorded in each article\'s page history. Each pack lists its articles and the revision used.',
  '',
  '| Pack | Article | Revision | Chunks used |',
  '|---|---|---|---|',
]
for (const p of packs)
  for (const s of p.sources)
    lines.push(`| ${p.id} | [${s.title}](${s.url}) | ${s.revid ?? ''} | ${p.chunks.filter((c) => c.outlet === s.outlet).length} |`)
writeFileSync(new URL('../fixtures/ATTRIBUTION.md', import.meta.url), lines.join('\n') + '\n')
console.log(`wrote attribution for ${packs.length} packs`)
