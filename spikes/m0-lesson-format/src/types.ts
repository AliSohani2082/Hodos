// Shared types for the lesson-format eval (lesson-ir.md §8).
// Both arms parse into the same neutral tree, so everything after parsing is syntax-blind.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
export type Arm = 'markdoc' | 'directive'
export const ARMS: Arm[] = ['markdoc', 'directive']

/** Shared error vocabulary shown to the model on repair (§8.2, "Errors shown on repair"). */
export type DiagId =
  | 'unknown-block' // name is not registered anywhere
  | 'disallowed-block' // registered, but not in this task's allowed set
  | 'missing-attr'
  | 'unknown-attr'
  | 'bad-value' // wrong type / enum / pattern / range / semantic check on a value
  | 'unclosed' // missing or mismatched closer
  | 'bad-syntax' // markup that did not parse as intended, wrong form for the block
  | 'bad-nesting'
  | 'bad-citation' // cite.chunk or perspective.outlet not in the source pack
  | 'bad-body' // body of the block (YAML / child tags) malformed
  | 'bad-frontmatter'

export interface Diagnostic {
  id: DiagId
  message: string
  /** 1-based line of the offending construct, when known. */
  line?: number
  block?: string
  attr?: string
  /** Where it came from: the arm's parser/structural checks, JSON Schema on attrs, or semantic (plugin) checks. */
  stage?: 'parse' | 'schema' | 'semantic'
}

/** A node of the neutral lesson tree. `block` nodes are registered lesson blocks; `prose` nodes are plain Markdown. */
export interface LNode {
  kind: 'block' | 'prose'
  /** Block name for blocks; mdast-ish name for prose: heading, paragraph, text, strong, em, del, code, fence, list, item, quote, link, image, br, hr, table. */
  type: string
  attrs: Record<string, Json>
  children: LNode[]
  /** Literal content for text, code and fence nodes. */
  text?: string
  line: number
  /** The block's body failed to parse (e.g. bad YAML); schema checks are skipped so one error is not reported as five. */
  broken?: boolean
}

export interface LDoc {
  frontmatter: Record<string, Json>
  children: LNode[]
}

export interface ParseResult {
  doc: LDoc
  diagnostics: Diagnostic[]
}

export interface ValidateResult extends ParseResult {
  /** Parse diagnostics plus schema and semantic diagnostics, deduplicated and sorted by line. */
  valid: boolean
}

/** What the validator knows about the task: the source pack and the allowed block set. */
export interface ValidationContext {
  chunkIds: Set<string>
  outlets: Set<string>
  /** Blocks the course can render. Anything else registered is `disallowed-block`. */
  allowed: Set<string>
}

export interface Chunk {
  id: string // src:<outlet>#c<n>
  outlet: string // src:<outlet>
  title: string
  text: string
}

export interface SourcePack {
  id: string
  chunks: Chunk[]
  /** Attribution for the CC-BY / CC-BY-SA / public-domain texts. */
  sources: { outlet: string; title: string; url: string; revid?: number; license: string }[]
}

export type DomainId = 'math' | 'programming' | 'chess' | 'language' | 'history' | 'science'
export type ShapeId = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'ADV1' | 'ADV2' | 'ADV3' | 'ADV4' | 'ADV5' | 'ADV6'

export interface ChecklistItem {
  block: string
  min: number
  /** Block must carry these attributes (after normalisation), e.g. exercise hints at 5 levels. */
  note?: string
}

export interface LiteralCheck {
  /** Where the literal must survive, after decoding: in code (fenced or inline), in prose text, or in a block attribute. */
  where: 'code' | 'text' | 'attr'
  block?: string
  attr?: string
  /** The decoded value (or substring, for code) that must be present. */
  value: string
}

export interface Task {
  id: string // e.g. math-s3
  domain: DomainId
  shape: ShapeId
  concept: string
  concept_id: string // dotted, goes in frontmatter
  level: string // learner level
  layout: string // course layout name + one-line description
  allowed: string[] // allowed block set
  pack: string // source pack id
  /** Chunk ids shown to the model (8 to 12 chunks of the pack). */
  chunkIds: string[]
  checklist: ChecklistItem[]
  literals?: LiteralCheck[]
  /** Ancestor chain that must exist somewhere, in order (e.g. list > callout > perspective). */
  nesting?: string[]
  targetWords: number
  /** Extra task text, e.g. the adversarial instruction. */
  brief: string
}

export type Model = 'claude-opus-5-5' | 'claude-sonnet-5-5' | 'claude-haiku-5-5'
