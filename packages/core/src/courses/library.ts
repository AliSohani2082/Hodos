/**
 * The course library: courses shipped in plugins' content packs, and courses
 * proposed by an agent or imported from the course inbox, which stay drafts
 * until the learner approves them in the workspace. Approved courses are
 * question banks: the tutor of a learning session may ask their verified
 * exercises instead of writing its own.
 *
 * It also owns learner identity (principals and host sessions bound to
 * learners) and the delegation budget for drafting courses.
 * @module @hodos/core/courses/library
 */
import { isCourse, validateCourseShape, type CourseSpec, type ItemProvenance } from '@hodos/plugin-sdk'
import type { Actor } from '../actor.js'
import { systemClock, type Clock } from '../clock.js'
import { DEFAULT_CHECKPOINT_SIZE, validateCourse } from '../content/course.js'
import { authoringGuide } from '../content/guide.js'
import { stampBlockIds } from '../content/lesson.js'
import { HodosError } from '../errors.js'
import { brandId, randomIds, type IdGenerator, type LearnerId } from '../ids.js'
import { DEFAULT_LIMITS, RateLimiter, type BucketName, type BucketSpec } from '../limits/rate-limiter.js'
import type { PluginRegistry } from '../registry/registry.js'
import type { CourseRecord, HodosStore } from '../store/store.js'

/** An item without its `verifiedBy` claims (where it came from and its author are kept). */
function withoutVerificationClaims<T extends { readonly provenance?: ItemProvenance }>(item: T): T {
  if (item.provenance?.verifiedBy === undefined) return item
  const { verifiedBy: _claims, ...rest } = item.provenance
  return { ...item, provenance: rest }
}

/** Course library dependencies. */
export interface CourseLibraryDeps {
  readonly store: HodosStore
  readonly registry: PluginRegistry
  readonly clock?: Clock
  readonly ids?: IdGenerator
  /** Rate limits for model-written proposals (`generate`) and drafting delegations (`delegate`). */
  readonly limits?: Readonly<Record<BucketName, BucketSpec>>
  readonly logger?: { info(m: string): void; warn(m: string): void; error(m: string): void }
}

/** An approved course in the catalog. */
export interface CatalogEntry {
  readonly id: string
  readonly version: string
  readonly title: string
  readonly description: string
  readonly environments: readonly string[]
  /** Every environment the course needs is installed. */
  readonly available: boolean
  readonly goal: string
  readonly skills: ReadonlyArray<{ readonly id: string; readonly title: string; readonly kind: string }>
}

/** A draft course awaiting the learner's decision (no answer keys). */
export interface DraftSummary {
  readonly id: string
  readonly version: string
  readonly title: string
  readonly description: string
  readonly origin: 'agent' | 'import'
  readonly proposedBy: string
  readonly skills: ReadonlyArray<{ readonly id: string; readonly title: string; readonly kind: string; readonly requires: readonly string[] }>
  readonly lessons: number
  readonly items: number
}

/** The outcome of a course proposal. */
export interface ProposalResult {
  readonly stored: boolean
  readonly courseId: string
  readonly version: string
  readonly errors: readonly string[]
  readonly warnings: readonly string[]
}

/** The course library. One instance per store. */
export class CourseLibrary {
  private readonly store: HodosStore
  private readonly registry: PluginRegistry
  private readonly clock: Clock
  private readonly ids: IdGenerator
  private readonly limiter: RateLimiter
  private readonly logger: NonNullable<CourseLibraryDeps['logger']>

  /** @param deps - store, registry and optional clock, ids, limits and logger. */
  constructor(deps: CourseLibraryDeps) {
    this.store = deps.store
    this.registry = deps.registry
    this.clock = deps.clock ?? systemClock
    this.ids = deps.ids ?? randomIds
    this.limiter = new RateLimiter(this.clock, deps.limits ?? DEFAULT_LIMITS)
    this.logger = deps.logger ?? { info: () => {}, warn: () => {}, error: () => {} }
  }

  private now(): string {
    return this.clock.now().toISOString()
  }

  // ---------------------------------------------------------------- identity

  /**
   * Resolve an authenticated host principal to a learner, creating the learner on first use.
   * @param principal - stable principal key from the host's authentication (never from a model).
   * @param displayName - name for a new learner.
   * @returns the learner id.
   */
  learnerForPrincipal(principal: string, displayName = 'Learner'): LearnerId {
    const existing = this.store.learnerForPrincipal(principal)
    if (existing !== undefined) return existing
    const id = brandId<'LearnerId'>(this.ids.next('lrn'))
    this.store.transaction(() => {
      this.store.insertLearner({ id, displayName, settings: {}, createdAt: this.now() })
      this.store.bindPrincipal(principal, id)
    })
    return id
  }

  /**
   * The learner bound to a host session (e.g. a DeepSeek Harness session), binding it on first use.
   * @param sessionId - host session id (trusted, from the host runtime).
   * @param defaultPrincipal - principal to bind an unbound session to.
   * @returns the learner id.
   */
  learnerForSession(sessionId: string, defaultPrincipal: string): LearnerId {
    const binding = this.store.sessionBinding(sessionId)
    if (binding !== undefined) return binding.learnerId
    const learnerId = this.learnerForPrincipal(defaultPrincipal)
    this.store.bindSession(sessionId, learnerId, this.now())
    return learnerId
  }

  // ---------------------------------------------------------------- courses

  /**
   * Import the courses of every registered content pack (validated) as approved shipped content.
   * Existing course versions are immutable and kept.
   * @returns findings per rejected course.
   */
  async syncContentPacks(): Promise<Array<{ courseId: string; errors: string[] }>> {
    const rejected: Array<{ courseId: string; errors: string[] }> = []
    const trusted = new Set(this.registry.plugins().filter(p => p.trusted).map(p => p.manifest.id))
    for (const { pluginId, pack } of this.registry.contentPacks()) {
      for (const shipped of pack.courses) {
        // How a sandboxed plugin says its items were checked is its own claim: the tutor is not told it.
        const course = trusted.has(pluginId) ? shipped : { ...shipped, items: shipped.items.map(withoutVerificationClaims) }
        if (this.store.course(course.id, course.version) !== undefined) continue
        const findings = await validateCourse(course, this.registry, { requireCoverage: false })
        const errors = findings.filter(f => f.severity === 'error')
        if (errors.length > 0) {
          rejected.push({ courseId: course.id, errors: errors.map(e => e.message) })
          this.logger.error(`course ${course.id}@${course.version} from ${pluginId} rejected: ${errors.map(e => e.message).join('; ')}`)
          continue
        }
        this.store.upsertCourse({
          id: course.id, version: course.version, status: 'approved', origin: 'pack', pluginId, title: course.title,
          spec: { ...course, lessons: course.lessons.map(l => ({ ...l, source: stampBlockIds(l.source, l.id) })) },
          proposedBy: null, createdAt: this.now(), approvedAt: this.now(),
        })
      }
    }
    return rejected
  }

  private courseAvailable(spec: CourseSpec): boolean {
    const envs = new Set(this.registry.environments())
    return spec.environments.every(e => envs.has(e))
  }

  /**
   * The approved courses (latest version of each) with availability.
   * @returns the catalog.
   */
  catalog(): CatalogEntry[] {
    const latest = new Map<string, CourseRecord>()
    for (const c of this.store.courses('approved')) if (!latest.has(c.id)) latest.set(c.id, c)
    return [...latest.values()].map(c => ({
      id: c.id, version: c.version, title: c.title, description: c.spec.description, environments: [...c.spec.environments],
      available: this.courseAvailable(c.spec), goal: c.spec.goal,
      skills: c.spec.skills.map(s => ({ id: s.id, title: s.title, kind: s.kind })),
    }))
  }

  /**
   * Charge one subagent delegation against the learner's daily budget.
   * @param learnerId - the learner.
   * @throws {HodosError} `RATE_LIMITED` when the budget is spent.
   */
  chargeDelegation(learnerId: LearnerId): void {
    this.limiter.take(learnerId, 'delegate')
  }

  // ---------------------------------------------------------------- course authoring

  /**
   * The course authoring guide for the installed environments.
   * @param options - detail level.
   * @returns Markdown text.
   */
  authoringGuide(options: { schemas?: boolean } = {}): string {
    return authoringGuide(this.registry, { ...options, checkpointSize: DEFAULT_CHECKPOINT_SIZE })
  }

  /**
   * Validate and store a proposed course: from the tutor agent or a subagent
   * (`agent`), or from a file in the host's course inbox (`import`, for
   * example a course written with Claude Code). Proposed courses are drafts
   * until the learner approves them in the workspace, and their provenance is
   * set here: claims inside a proposal ("verified by …") are not taken over.
   * @param actor - proposer.
   * @param proposal - the proposed course (untrusted).
   * @param options - where it came from; `source` names it for the learner (e.g. the inbox file).
   * @returns validation findings and whether it was stored as a draft.
   */
  async proposeCourse(actor: Actor, proposal: unknown, options: { origin?: 'agent' | 'import'; source?: string } = {}): Promise<ProposalResult> {
    const origin = options.origin ?? 'agent'
    // Model-written proposals are rate-limited; inbox imports need a local file and the learner's approval.
    if (origin === 'agent') this.limiter.take(actor.learnerId, 'generate')
    if (!isCourse(proposal)) {
      const shape = validateCourseShape(proposal)
      const field = (name: string): string => {
        const v: unknown = typeof proposal === 'object' && proposal !== null && name in proposal ? Object.getOwnPropertyDescriptor(proposal, name)?.value : undefined
        return typeof v === 'string' ? v.slice(0, 64) : ''
      }
      return { stored: false, courseId: field('id'), version: field('version'), errors: shape.slice(0, 20).map(d => `${d.code}: ${d.message}`), warnings: [] }
    }
    const course = proposal
    const findings = await validateCourse(course, this.registry, { requireCoverage: false })
    const errors = findings.filter(f => f.severity === 'error').map(f => `${f.code}: ${f.message}`)
    const warnings = findings.filter(f => f.severity === 'warning').map(f => `${f.code}: ${f.message}`)
    if (errors.length > 0) return { stored: false, courseId: course.id, version: course.version, errors, warnings }
    const existing = this.store.course(course.id, course.version)
    if (existing?.status === 'approved') {
      return { stored: false, courseId: course.id, version: course.version, errors: ['course/version-exists: this course version is already approved; bump the version'], warnings }
    }
    // Replacing a waiting draft from another source would change what the learner approves while the
    // workspace still shows it as coming from that source (an imported course swapped for a model-written one).
    if (existing !== undefined && existing.origin !== origin) {
      return { stored: false, courseId: course.id, version: course.version, errors: ['course/version-exists: a draft of this course version from another source is waiting for review; bump the version'], warnings }
    }
    const provenance: ItemProvenance = { source: origin === 'import' ? 'imported' : 'generated' }
    this.store.upsertCourse({
      id: course.id, version: course.version, status: 'draft', origin, pluginId: null, title: course.title,
      spec: {
        ...course,
        lessons: course.lessons.map(l => ({ ...l, source: stampBlockIds(l.source, l.id) })),
        items: course.items.map(item => ({ ...item, provenance })),
      },
      proposedBy: options.source === undefined ? actor.channel : options.source.slice(0, 200), createdAt: this.now(), approvedAt: null,
    })
    return { stored: true, courseId: course.id, version: course.version, errors, warnings }
  }

  /**
   * Draft courses awaiting approval.
   * @returns drafts with their skill graphs (no answer keys).
   */
  drafts(): DraftSummary[] {
    return this.store.courses('draft').map(c => ({
      id: c.id, version: c.version, title: c.title, description: c.spec.description,
      origin: c.origin === 'import' ? 'import' as const : 'agent' as const, proposedBy: c.proposedBy ?? '',
      skills: c.spec.skills.map(s => ({ id: s.id, title: s.title, kind: s.kind, requires: [...(s.requires ?? [])] })),
      lessons: c.spec.lessons.length, items: c.spec.items.length,
    }))
  }

  /**
   * Approve or reject a draft course. Only the learner's own channel may decide.
   * @param actor - must use the `ui` channel.
   * @param request - course id, version and decision.
   */
  async decideCourse(actor: Actor, request: { courseId: string; version: string; approve: boolean }): Promise<void> {
    if (actor.channel !== 'ui') throw new HodosError('FORBIDDEN', 'only the learner can approve a proposed course, in the Hodos workspace')
    const course = this.store.course(request.courseId, request.version)
    if (course === undefined || course.status !== 'draft') throw new HodosError('NOT_FOUND', 'no such draft course')
    if (request.approve) {
      const errors = (await validateCourse(course.spec, this.registry, { requireCoverage: false })).filter(f => f.severity === 'error')
      if (errors.length > 0) throw new HodosError('INVALID_STATE', `the course no longer validates: ${errors.map(e => e.message).join('; ')}`)
    }
    this.store.setCourseStatus(request.courseId, request.version, request.approve ? 'approved' : 'rejected', this.now())
  }
}
