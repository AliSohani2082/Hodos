// Builds the source packs (§8.3): 3 real Wikipedia articles per task (CC BY-SA 4.0), cut into ~300-token chunks,
// 8 to 12 chunks per pack. Run once; the output is committed so the eval is reproducible without the network.
//   bun run scripts/build-packs.ts            (all packs)
//   bun run scripts/build-packs.ts math-s1    (one pack)
import { mkdirSync, writeFileSync } from 'node:fs'
import type { Chunk, SourcePack } from '../src/types.ts'

/** task id -> Wikipedia article titles. One article = one outlet. Order = priority. */
export const ARTICLES: Record<string, string[]> = {
  // math
  'math-s1': ['Pythagorean theorem', 'Pythagorean triple', 'Euclid\'s Elements'],
  'math-s2': ['Derivative', 'Slope', 'Leibniz–Newton calculus controversy'],
  'math-s3': ['Prime number', 'Sieve of Eratosthenes', 'Fundamental theorem of arithmetic'],
  'math-s4': ['Linear equation', 'Equation', 'History of algebra'],
  'math-s5': ['Bayes\' theorem', 'Probability', 'Conditional probability'],
  // programming
  'programming-s1': ['Recursion (computer science)', 'Tail call', 'Recursion'],
  'programming-s2': ['Binary search', 'Linear search', 'Divide-and-conquer algorithm'],
  'programming-s3': ['Hash table', 'Hash function', 'Hash collision'],
  'programming-s4': ['Big O notation', 'Time complexity', 'Analysis of algorithms', 'Best, worst and average case'],
  'programming-s5': ['Stack (abstract data type)', 'Queue (abstract data type)', 'Call stack'],
  // chess
  'chess-s1': ['Pin (chess)', 'Skewer (chess)', 'Chess tactic'],
  'chess-s2': ['Fork (chess)', 'Knight (chess)', 'Chess tactic'],
  'chess-s3': ['Chess opening', 'Chess strategy', 'Chess opening theory'],
  'chess-s4': ['Checkmate', 'Fool\'s mate', 'Back-rank checkmate'],
  'chess-s5': ['Chess endgame', 'Opposition (chess)', 'Pawn endgame'],
  // language learning
  'language-s1': ['Spanish verbs', 'Romance copula', 'Spanish grammar'],
  'language-s2': ['Japanese writing system', 'Hiragana', 'Katakana'],
  'language-s3': ['Grammatical case', 'German declension', 'German grammar', 'Declension'],
  'language-s4': ['Grammatical gender', 'French grammar', 'Noun class'],
  'language-s5': ['Tone (linguistics)', 'Standard Chinese phonology', 'Pinyin'],
  // history / humanities: outlets that genuinely disagree
  'history-s1': ['Causes of World War I', 'Historiography of the causes of World War I', 'Fischer controversy'],
  'history-s2': ['Fall of the Western Roman Empire', 'Migration Period', 'Historiography of the fall of the Western Roman Empire'],
  'history-s3': ['Industrial Revolution', 'Great Divergence', 'British Agricultural Revolution'],
  'history-s4': ['Atomic bombings of Hiroshima and Nagasaki', 'Debate over the atomic bombings of Hiroshima and Nagasaki', 'Operation Downfall'],
  'history-s5': ['French Revolution', 'Historiography of the French Revolution', 'Reign of Terror'],
  // natural science
  'science-s1': ['Photosynthesis', 'Calvin cycle', 'Light-dependent reactions'],
  'science-s2': ['Half-life', 'Radioactive decay', 'Exponential decay'],
  'science-s3': ['Plate tectonics', 'Continental drift', 'Alfred Wegener'],
  'science-s4': ['Natural selection', 'Modern synthesis (20th century)', 'Fitness (biology)'],
  'science-s5': ['Greenhouse effect', 'Global warming', 'Carbon cycle'],
  // adversarial
  'adv1': ['Jinja (template engine)', 'Mustache (template system)', 'Web template system', 'Template processor'],
  'adv2': ['Taylor series', 'Series (mathematics)', 'Convergent series'],
  'adv3': ['Hiragana', 'Kanji', 'Japanese language'],
  'adv4': ['Treaty of Versailles', 'The Economic Consequences of the Peace', 'Paris Peace Conference, 1919'],
  'adv5': ['Chess piece relative value', 'Chess endgame', 'Chess strategy'],
  'adv6': ['Cell cycle', 'Mitosis', 'Cell cycle checkpoint'],
}

const UA = 'hodos-m0-lesson-format-eval/0.1 (open-source research spike)'
const CHUNK_MIN = 600
const CHUNK_MAX = 1300 // about 150 to 330 tokens
const PER_OUTLET = 4

const slug = (s: string) =>
  s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

const CACHE = new URL('../fixtures/.cache/', import.meta.url)

async function fetchArticle(title: string): Promise<{ title: string; revid: number; text: string } | null> {
  mkdirSync(CACHE, { recursive: true })
  const cacheFile = new URL(`${encodeURIComponent(title)}.json`, CACHE)
  if (await Bun.file(cacheFile).exists()) return (await Bun.file(cacheFile).json()) as { title: string; revid: number; text: string } | null
  const got = await fetchArticleLive(title)
  writeFileSync(cacheFile, JSON.stringify(got))
  return got
}

async function fetchArticleLive(title: string): Promise<{ title: string; revid: number; text: string } | null> {
  const url = new URL('https://en.wikipedia.org/w/api.php')
  for (const [k, v] of Object.entries({
    action: 'query', prop: 'extracts|revisions', explaintext: '1', exsectionformat: 'plain', rvprop: 'ids',
    redirects: '1', titles: title, format: 'json', formatversion: '2',
  })) url.searchParams.set(k, v)
  let res: Response | undefined
  for (let attempt = 0; attempt < 6; attempt++) {
    res = await fetch(url, { headers: { 'User-Agent': UA } })
    if (res.status !== 429 && res.status < 500) break
    const wait = Math.max(Number(res.headers.get('retry-after')) || 0, 2 ** attempt) * 1000
    console.log(`   (HTTP ${res.status} for ${title}; waiting ${wait / 1000}s)`)
    await Bun.sleep(wait)
  }
  if (!res || !res.ok) throw new Error(`HTTP ${res?.status} for ${title}`)
  await Bun.sleep(600)
  const page = (await res.json()).query.pages[0]
  if (!page || page.missing || !page.extract) return null
  return { title: page.title, revid: page.revisions?.[0]?.revid, text: page.extract }
}

const looksLikeFormulaResidue = (p: string) =>
  /displaystyle|\\mathbf|\\frac|\\sum/.test(p) || (p.match(/\n/g)?.length ?? 0) > 4 || (p.match(/\s/g)?.length ?? 0) / p.length > 0.3

/** Paragraphs -> chunks of 600 to 1300 characters, cut at sentence boundaries. Headings and formula residue are dropped. */
const isHeadingLine = (l: string) => /^[A-Z][^.!?:;]{0,70}$/.test(l.trim())

export function chunkText(text: string): string[] {
  const paras = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p && !looksLikeFormulaResidue(p))
    .map((p) => p.split('\n').filter((l) => l.trim() && !isHeadingLine(l)))
    .filter((lines) => lines.length <= 2) // longer blocks are lists or tables
    .map((lines) => lines.join(' '))
    .filter((p) => p.length >= 120)
  const out: string[] = []
  let cur = ''
  const flush = () => { if (cur.length >= CHUNK_MIN) out.push(cur.trim()); cur = '' }
  for (const p of paras) {
    const sentences = p.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) ?? [p]
    for (const s of sentences) {
      if (cur.length + s.length > CHUNK_MAX) flush()
      cur += (cur ? ' ' : '') + s.trim()
    }
    if (cur.length >= CHUNK_MIN) flush()
  }
  if (cur.length >= CHUNK_MIN) out.push(cur.trim())
  return out
}

export async function buildPack(id: string, titles: string[]): Promise<SourcePack & { warnings: string[] }> {
  const chunks: Chunk[] = []
  const sources: SourcePack['sources'] = []
  const warnings: string[] = []
  for (const t of titles) {
    const art = await fetchArticle(t)
    if (!art) { warnings.push(`missing article: ${t}`); continue }
    const outlet = `src:wiki-${slug(art.title)}`
    if (sources.some((s) => s.outlet === outlet)) { warnings.push(`duplicate outlet ${outlet} (redirect?) for ${t}`); continue }
    const cut = chunkText(art.text).slice(0, PER_OUTLET)
    if (cut.length < 2) warnings.push(`only ${cut.length} usable chunks in ${art.title}`)
    sources.push({ outlet, title: art.title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(art.title.replaceAll(' ', '_'))}`, revid: art.revid, license: 'CC BY-SA 4.0' })
    cut.forEach((text, i) => chunks.push({ id: `${outlet}#c${i + 1}`, outlet, title: art.title, text }))
  }
  // Cap at 12 chunks by trimming the outlet that has the most.
  while (chunks.length > 12) {
    const counts = new Map<string, number>()
    for (const c of chunks) counts.set(c.outlet, (counts.get(c.outlet) ?? 0) + 1)
    const biggest = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0]
    chunks.splice(chunks.map((c) => c.outlet).lastIndexOf(biggest), 1)
  }
  if (chunks.length < 8) warnings.push(`only ${chunks.length} chunks in pack (need 8 to 12)`)
  return { id, chunks, sources: sources.filter((src) => chunks.some((c) => c.outlet === src.outlet)), warnings }
}

if (import.meta.main) {
  const only = process.argv[2]
  mkdirSync(new URL('../fixtures/packs/', import.meta.url), { recursive: true })
  let bad = 0
  const force = process.argv.includes('--force')
  for (const [id, titles] of Object.entries(ARTICLES)) {
    if (only && !only.startsWith('--') && id !== only) continue
    if (!force && (await Bun.file(new URL(`../fixtures/packs/${id}.json`, import.meta.url)).exists())) { console.log(`${id.padEnd(16)} (exists, skipped)`); continue }
    const { warnings, ...pack } = await buildPack(id, titles)
    writeFileSync(new URL(`../fixtures/packs/${id}.json`, import.meta.url), JSON.stringify(pack, null, 1) + '\n')
    const words = pack.chunks.reduce((n, c) => n + c.text.split(/\s+/).length, 0)
    console.log(`${id.padEnd(16)} ${String(pack.chunks.length).padStart(2)} chunks ${String(words).padStart(5)} words  ${pack.sources.map((s) => s.title).join(' | ')}`)
    for (const w of warnings) { console.log(`   WARN ${w}`); bad++ }
  }
  console.log(bad ? `\n${bad} warnings` : '\nall packs ok')
}
