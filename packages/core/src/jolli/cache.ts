/**
 * THE ONE COPY OF THE COURSE CATALOGUE, SHARED BY TWO PROCESSES.
 *
 * ⚠ THE CACHE IS A CORRECTNESS MECHANISM HERE, NOT A SPEED ONE. Two processes need this data: the
 * Electron main process decides whether a student may enter at all and bakes the model list into
 * the sidecar's config before forking it, and the sidecar answers `/jolli/course` for the renderer.
 * If they fetched independently they would disagree — a gate that admitted a student and a course
 * list that came back empty behind it is the shape that bug takes. So main writes and the server
 * reads, through one file, with `Flock` because they can race.
 *
 * ⚠ IT STORES WHAT THE GATEWAY SAID, NOT WHAT A SCREEN SHOULD SHOW. The hard filter is baked in
 * (it depends only on `requiresCoding` and `viewerRole`, both pure data), but `entryState` is not:
 * that is a function of TODAY, and a course cached as `open` yesterday can be `ended` now. Every
 * derived value is computed after the read — see `catalog.ts`.
 *
 * ⚠ AND "STALE" IS NOT "ABSENT". The TTL is short so a professor's edits land quickly, which means
 * an offline student's cache is always expired. Refusing to serve it would make the product
 * unusable on a train; `stale-if-error` is the rule, and {@link loadCatalog} reports staleness
 * rather than hiding it.
 */
import { readdir, rename, rm, stat, readFile, mkdir, utimes, writeFile } from "node:fs/promises"
import path from "path"
import { Duration, Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Global } from "../global"
import { Flock } from "../util/flock"
import { Hash } from "../util/hash"
import {
  fetchAssistantChoices,
  fetchModelIndex,
  fetchMyCourses,
  type CatalogModel,
  type CourseAssistantChoice,
  JolliApiError,
  type GatewayRequest,
  type OrgRef,
  scopedRequest,
} from "./api"
import { addressOf, isVisibleCourse, type ListedCourse } from "./catalog"
import { orgScopedId, sameOrg } from "./org-scoped-id"

/** ⚠ Short on purpose: a professor's model grant should land in minutes, not at next launch. */
const TTL = Duration.minutes(5)

/**
 * HOW LONG A SNAPSHOT SOME ORG DID NOT ANSWER STANDS BEFORE IT IS ASKED AGAIN, COUNTED FROM THE LAST
 * ATTEMPT RATHER THAN THE LAST ANSWER.
 *
 * ⚠ IT CANNOT BE ZERO. An org that times out on the gateway keeps doing so for a while, and jolliedu
 * waits its full fan-out timeout (5s) for it every time — as long as `course-guardrails.ts` gives a
 * whole refresh. Refreshed on every read, each message would wait out that deadline, be cut off
 * before the write, and leave the next message to do it again.
 *
 * ⚠ FROM THE ATTEMPT, BECAUSE AN INTERRUPTED ATTEMPT WRITES NOTHING. Spacing retries by the file's
 * last write would let every caller past the window retry; `loadCatalog` touches the snapshot as it
 * begins one instead.
 */
const RETRY = Duration.minutes(1)

/**
 * HOW LONG A REFRESH MAY TAKE BEFORE THE STALE COPY WINS.
 *
 * ⚠ THE PER-REQUEST TIMEOUTS DO NOT ADD UP TO A BOUND, WHICH IS WHY THIS EXISTS. `api.ts` gives
 * each call 15 seconds, but a refresh makes two in sequence (courses and models together, then the
 * assistant batch) and `Flock` waits five minutes for a lock by default — so the worst case a caller actually
 * faces is minutes, not seconds. The callers that cannot afford that pass {@link STARTUP_DEADLINE};
 * this is the backstop for everyone else.
 *
 * ⚠ RUNNING OUT OF TIME IS NOT AN ERROR PATH. It lands in the same place a failed fetch does — the
 * stale snapshot, and `unreachable` only when there is nothing behind it at all.
 */
const REFRESH_DEADLINE = Duration.seconds(45)

/**
 * HOW LONG A CALLER THAT IS HOLDING UP A LAUNCH MAY WAIT.
 *
 * ⚠ ONE CONSTANT FOR ALL OF THEM, BECAUSE IT IS THE SAME WAIT SEEN FROM THREE PROCESSES.
 * `createSidecarEnv()` is not forking a server until this returns, the course gate is the screen the
 * student is looking at, and config loading is not starting a server — in every one of them a second
 * spent here is a second the product does not exist. The honest trade is a shorter wait and an
 * emptier first answer, which the next refresh corrects within the TTL.
 *
 * ⚠ IT IS NOT OPTIONAL FOR THOSE CALLERS THE WAY IT READS. {@link REFRESH_DEADLINE} is a backstop
 * for a caller with nobody watching; a launch path that forgets to pass this one inherits 45 seconds
 * of blank screen instead, which is the whole failure it exists to prevent.
 */
export const STARTUP_DEADLINE = Duration.seconds(20)

/**
 * ⚠ BUMP THIS WHENEVER THE SNAPSHOT'S ELEMENT SHAPES CHANGE. The validation below is deliberately
 * shallow — it checks that the three collections are collections — so a file written by an older
 * build would otherwise pass and flow straight into the mapping layer as the wrong shape. The
 * version is what makes "a shape we no longer understand is the same as no cache" true rather than
 * aspirational.
 */
/**
 * Bumped to 3 when courses came from every org: a course carries its org and `assistants` is keyed
 * by the course's org-scoped id, so an older build reading this snapshot would key another org's
 * course 7 as its home course 7.
 *
 * Bumped to 2 when models grew a `protocol` field. Older cache files carried `AgentModel[]`
 * without one, and the shallow validation in `readSnapshot` would let them through: every model
 * would then fail `runnableModels` (`catalog.ts`) as a protocol this build cannot run, leaving the
 * student an empty picker until the next successful refresh. `readSnapshot` returns undefined on a
 * version mismatch, which is exactly the "refetch rather than guess" posture we want here.
 *
 * ⚠ EXPORTED so `script/seed-jolli-catalog.ts` stamps the fixture it drops with the same version
 * this reader demands; a second copy of the number there would silently write unreadable files.
 */
export const CATALOG_SCHEMA = 3

/** What one tenant's snapshot holds. Raw gateway fields only — nothing derived. */
export interface CatalogSnapshot {
  readonly schema?: number
  /** Already hard-filtered: coding courses this viewer is actually in, from every org they are in. */
  readonly courses: readonly ListedCourse[]
  /** The org the list was answered as home, whose courses keep bare ids. See `addressOf`. */
  readonly home?: OrgRef
  /**
   * Keyed by the course's id as the catalogue projects it: bare for a home course, org-scoped for
   * any other. Order is the gateway's — default first.
   */
  readonly assistants: Readonly<Record<string, readonly CourseAssistantChoice[]>>
  readonly models: readonly CatalogModel[]
  /**
   * The orgs that did not answer the fetch that produced this snapshot, whose courses are as old as
   * the last answer they gave, or missing. Absent when every org answered.
   *
   * ⚠ A SNAPSHOT THAT HAS ANY IS NOT FRESH, HOWEVER RECENT. It is served `stale`, exactly as a
   * snapshot behind a failed refresh is, and stands only for {@link RETRY} rather than the TTL.
   */
  readonly unavailable?: readonly OrgRef[]
  /**
   * `Date.now()` when the fetch that produced this snapshot BEGAN, which a caller asking past the
   * cache compares against when its own request began — see `loadCatalog`.
   *
   * ⚠ WHEN IT BEGAN, NOT WHEN IT WAS WRITTEN. A fetch already under way when a Start was refused
   * read the gateway before the refusal; stamping its finish would let it pass for an answer to the
   * refresh that refusal asked for, and hand back the assistant that was just refused.
   *
   * ⚠ NOT THE FILE'S MTIME. That comes off the filesystem's coarser clock, with a fractional part
   * `Date.now()` lacks. Absent on a snapshot an older build wrote, which then answers no such caller.
   */
  readonly fetchedAt?: number
}

export type CatalogLoad =
  | {
      readonly kind: "ok"
      readonly snapshot: CatalogSnapshot
      readonly stale: boolean
      /**
       * What the refresh that would have replaced this snapshot failed with. Only ever set
       * alongside `stale`, because a fresh answer had nothing to fail.
       *
       * ⚠ IT EXISTS BECAUSE `stale-if-error` HIDES THE ERROR FROM THE ONE CALLER ENTITLED TO ACT ON
       * IT. Serving the old copy is right for every caller — that is the whole posture of this file
       * — but a 401 is not an outage, it is the backend saying the sign-in is over, and
       * `/jolli/course` renews on exactly that. Reported only through the `unreachable` branch, the
       * renewal ran for a student with nothing cached and never for one with a snapshot on disk:
       * the student who has actually been using the product is the one whose revoked credential
       * went unnoticed, behind a course list that looked perfectly normal.
       */
      readonly error?: JolliApiError
    }
  /** Nothing cached and the gateway could not be reached. Distinct from "you have no courses". */
  | { readonly kind: "unreachable"; readonly error: JolliApiError }

/** What every snapshot file is named with, and therefore what a sweep of them matches on. */
const PREFIX = "jolli-catalog-"

/**
 * ⚠ THE CREDENTIAL'S IDENTITY IS PART OF THE KEY, AND LEAVING IT OUT LEAKED ONE STUDENT'S COURSES
 * TO THE NEXT. Two students share a machine far more often here than in most products — a lab
 * bench, a loaner laptop — and the gate's own "use a different account" button makes the swap a
 * supported flow. Keyed by tenant alone, B signing in within the TTL was served A's snapshot: A's
 * courses in the picker, A's model catalogue baked into B's sidecar.
 *
 * ⚠ THE IDENTITY RATHER THAN THE TOKEN, AND THAT DISTINCTION IS WHAT MAKES REFRESH AFFORDABLE. The
 * access token rotates; keying on it meant every renewal produced a filename nothing had written,
 * so the student paid a cold three-request reload on the startup path and the previous snapshot was
 * left behind as an orphan. The identity is minted once per sign-in and never re-minted, so it
 * separates students exactly as the token did and survives every rotation.
 *
 * ⚠ IT IS HASHED, NEVER WRITTEN. The filename is derived from the credential but cannot be turned
 * back into it, so a cache directory listing discloses nothing usable.
 *
 * ⚠ AND IT IS EXPORTED SO THAT NOTHING HAS TO MIRROR IT. `script/seed-jolli-catalog.ts` drops a
 * fixture at the key this computes; a second copy of the formula there would go on writing files
 * nobody reads the day either half of it moved.
 */
export const catalogCachePath = (request: GatewayRequest) =>
  path.join(
    Global.Path.cache,
    `${PREFIX}${Hash.fast(`${request.origin}|${request.tenantSlug ?? ""}|${request.identity}`)}.json`,
  )

/**
 * HOW LONG A SNAPSHOT NOBODY IS REFRESHING ANY MORE IS KEPT.
 *
 * ⚠ ROTATION NO LONGER ORPHANS ONE — {@link catalogCachePath} keys on the credential's identity
 * rather than its token — BUT SIGNING IN AS SOMEBODY ELSE STILL DOES, and that was always the case
 * this window was sized for. {@link clearCatalogCache} runs on sign-out, which is exactly the path
 * a student who simply stops using a machine never takes. Each orphan is that student's course
 * codes, their instructors' assistant names and their model grants, left in a directory the next
 * account can read — the thing the key prevents being SERVED, still sitting there to be FOUND.
 *
 * ⚠ AN AGE RATHER THAN "EVERYTHING BUT MINE", BECAUSE TWO LIVE IDENTITIES ON ONE MACHINE IS REAL.
 * The development override (`JOLLICODE_JOLLI_TOKEN`) files under its own identity alongside the
 * signed-in student's, and a sweep that kept only the caller's would have the two deleting each
 * other's snapshot on every refresh. A window this long cannot be reached by anything still in use
 * — the TTL is five minutes.
 */
const RETENTION = Duration.days(7)

const readSnapshot = Effect.fn("Jolli.readSnapshot")(function* (file: string) {
  const raw = yield* Effect.promise(() =>
    readFile(file, "utf8")
      .then((text) => JSON.parse(text) as unknown)
      .catch(() => undefined),
  )
  if (!raw || typeof raw !== "object") return undefined
  const value = raw as Partial<CatalogSnapshot>
  // A shape we no longer understand is the same as no cache: refetch rather than guess.
  if (value.schema !== CATALOG_SCHEMA) return undefined
  if (!Array.isArray(value.courses) || !Array.isArray(value.models) || !value.assistants) return undefined
  return value as CatalogSnapshot
})

const isFresh = Effect.fn("Jolli.isFresh")(function* (file: string, ttl = TTL) {
  const mtime = yield* Effect.promise(() =>
    stat(file)
      .then((info) => info.mtimeMs)
      .catch(() => undefined),
  )
  if (mtime === undefined) return false
  return Date.now() - mtime < Duration.toMillis(ttl)
})

/**
 * Fetch the whole catalogue and write it down.
 *
 * ⚠ ONE COURSE FAILING MUST NOT COST THE STUDENT THE REST. `assistant-choices` is mounted with
 * `treatAsNotFound`, so a course the viewer cannot read answers 404 exactly as a deleted one does —
 * indistinguishable, and a perfectly ordinary thing to meet in a list. Failing the batch would take
 * every other course down with it; an empty assistant list renders as "this course has no
 * assistants yet", which is a sentence a student can act on.
 *
 * ⚠ EACH COURSE'S ASSISTANTS ARE ASKED FOR IN THE COURSE'S OWN ORG. Its numeric id means another
 * course in any other org, so an unscoped read of an org-B course reads home's course of that number.
 *
 * ⚠ THE MODELS ARE ASKED FOR ONCE, UNSCOPED. jolliedu serves one routing catalogue for the whole
 * deployment, so every org the student reaches grants out of the same Registry UUIDs.
 *
 * ⚠ AN ANSWER THAT NAMES NO HOME KEEPS THE LAST ONE. Which org is home decides every home course's
 * id, so one answer without it would turn each "7" into "tenant:org:7" and leave every session bound
 * to a home course reading as bound to a course that is gone.
 */
export const refreshCatalog = Effect.fn("Jolli.refreshCatalog")(function* (request: GatewayRequest) {
  const fetchedAt = Date.now()
  const file = catalogCachePath(request)
  const [listed, models] = yield* Effect.all([fetchMyCourses(request), fetchModelIndex(request)], {
    concurrency: 2,
  })
  // Read only when it can matter: usually every org answers and the answer names its home.
  const previous = listed.unavailable.length > 0 || !listed.home ? yield* readSnapshot(file) : undefined
  const home = listed.home ?? previous?.home
  const fetched = listed.courses.filter(isVisibleCourse)
  const pairs = yield* Effect.forEach(
    fetched,
    (course) => {
      const org = addressOf(course, home)
      return fetchAssistantChoices(scopedRequest(request, org), course.id).pipe(
        Effect.catch((error) =>
          Effect.logDebug("Jolli: could not list a course's assistants", { course: course.id, error }).pipe(
            Effect.as([] as readonly CourseAssistantChoice[]),
          ),
        ),
        Effect.map((choices) => [orgScopedId(org, course.id), choices] as const),
      )
    },
    { concurrency: 6 },
  )
  const kept = carriedForward(
    previous,
    home,
    listed.unavailable,
    new Set(listed.courses.map((course) => orgScopedId(addressOf(course, home), course.id))),
  )
  const snapshot: CatalogSnapshot = {
    schema: CATALOG_SCHEMA,
    courses: [...fetched, ...kept.courses],
    ...(home ? { home } : {}),
    assistants: { ...kept.assistants, ...Object.fromEntries(pairs) },
    models: Array.from(models.values()),
    ...(listed.unavailable.length > 0 ? { unavailable: listed.unavailable } : {}),
    fetchedAt,
  }

  /**
   * Written to a sibling and renamed, so a reader never meets a half-written snapshot.
   *
   * ⚠ A FAILED WRITE IS REPORTED BUT NOT RAISED, AND BOTH HALVES MATTER. Raising would throw away
   * a catalogue that was fetched perfectly well over a cache that could not be written — but
   * swallowing it in silence is how the two processes this file exists to keep in step end up
   * fetching independently forever, with nothing anywhere saying why. A read-only or full cache
   * directory is the realistic cause and it is not self-evident from any other symptom.
   */
  const written = yield* writeAtomically(file, JSON.stringify(snapshot))
  if (written) yield* Effect.logWarning("Jolli: could not write the catalogue snapshot", { file, cause: written })
  yield* sweepOrphans(file)
  return snapshot
})

/**
 * THE LAST SNAPSHOT'S COURSES IN AN ORG THAT DID NOT ANSWER THIS TIME, WITH THEIR ASSISTANTS.
 *
 * ⚠ AN ORG THAT TIMED OUT IS NOT AN ORG WITH NO COURSES. Dropping its courses would take them off
 * the picker and leave every session bound to one reading as a course that is gone, until a refresh
 * happened to catch that org up. The copy kept is as old as the last answer that org gave, which is
 * the same trade `stale-if-error` makes for the whole catalogue — and served as stale for the same
 * reason, through the snapshot's `unavailable`.
 *
 * ⚠ ONLY UNDER THE SAME HOME. The assistants are keyed by ids the old home decided were bare or
 * scoped, so a snapshot answered under another home is keyed in a form this one does not read.
 *
 * ⚠ NEVER A COURSE THIS ANSWER ALREADY HAS. An org can be late and still send part of its list;
 * the course it did send is the newer copy, and a second row with the same id is a duplicate in
 * every picker.
 *
 * ⚠ "HAS" MEANS LISTED, NOT SHOWN. A course the answer lists but `isVisibleCourse` now hides — it
 * stopped requiring code, or the student's role in it changed — is the server's newer word too;
 * matched against the visible ones only, the old copy would bring it back to the picker.
 */
function carriedForward(
  previous: CatalogSnapshot | undefined,
  home: OrgRef | undefined,
  unavailable: readonly OrgRef[],
  listed: ReadonlySet<string>,
) {
  if (!previous || unavailable.length === 0 || !sameOrg(previous.home, home)) return { courses: [], assistants: {} }
  const courses = previous.courses
    .filter((course) => course.org && unavailable.some((org) => sameOrg(org, course.org)))
    .map((course) => ({ course, id: orgScopedId(addressOf(course, home), course.id) }))
    .filter((kept) => !listed.has(kept.id))
  return {
    courses: courses.map((kept) => kept.course),
    assistants: Object.fromEntries(
      courses.flatMap((kept) => (previous.assistants[kept.id] ? [[kept.id, previous.assistants[kept.id]]] : [])),
    ),
  }
}

/** Whether every org answered the fetch behind a snapshot. One that is not is served stale. */
const isComplete = (snapshot: CatalogSnapshot) => !snapshot.unavailable?.length

/** Whether a snapshot may answer without asking: within its TTL, or within {@link RETRY} when some org did not answer. */
const stands = (file: string, snapshot: CatalogSnapshot) => isFresh(file, isComplete(snapshot) ? TTL : RETRY)

/** Mark an attempt to refresh `file` as made now. Never fails: at worst the next caller retries sooner. */
const touch = (file: string) =>
  Effect.promise(() => {
    const now = new Date()
    return utimes(file, now, now).catch(() => {})
  })

/** Write through a sibling and a rename, so no reader meets half a file. Answers the failure, if any. */
const writeAtomically = (file: string, contents: string) =>
  Effect.promise(async () => {
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    try {
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(temp, contents)
      await rename(temp, file)
      return undefined
    } catch (cause) {
      await rm(temp, { force: true }).catch(() => {})
      return cause
    }
  })

/**
 * THE COURSE-CHAT MCP DISCOVERY ANSWER, KEPT BESIDE THE CATALOGUE AND ON ITS TERMS.
 *
 * ⚠ WITHOUT IT, ONE BAD STARTUP COST THE WHOLE INSTANCE ITS COURSE TOOLS. Config is loaded once per
 * instance, so a discovery that timed out or found the gateway down left the instance without the
 * `jolliedu` server for as long as it lived, and a slow gateway made every instance wait for it.
 * The answer is close to static — the deployment's canonical MCP URL — so a recent one is used
 * without asking, and an older one stands in when asking fails.
 *
 * ⚠ SAME PREFIX AS THE CATALOGUE, DELIBERATELY. Sign-out's {@link clearCatalogCache} and the orphan
 * sweep both match on it, so a student's discovery answer leaves the machine with their catalogue
 * instead of needing a second clean-up path that could be forgotten. Keyed the same way too, by
 * the credential's identity, so one student is never served another's answer.
 */
const MCP_CONFIG_SCHEMA = 1

export const mcpConfigCachePath = (request: GatewayRequest) =>
  path.join(
    Global.Path.cache,
    `${PREFIX}mcp-${Hash.fast(`${request.origin}|${request.tenantSlug ?? ""}|${request.identity}`)}.json`,
  )

/** The last discovery answer this identity received, and whether it is recent enough to use unasked. */
export const readMcpConfigCache = Effect.fn("Jolli.readMcpConfigCache")(function* (request: GatewayRequest) {
  const file = mcpConfigCachePath(request)
  const raw = yield* Effect.promise(() =>
    readFile(file, "utf8")
      .then((text) => JSON.parse(text) as unknown)
      .catch(() => undefined),
  )
  if (!raw || typeof raw !== "object") return undefined
  const value = raw as { schema?: unknown; mcp?: unknown }
  if (value.schema !== MCP_CONFIG_SCHEMA || !value.mcp || typeof value.mcp !== "object") return undefined
  return { mcp: value.mcp as Readonly<Record<string, unknown>>, fresh: yield* isFresh(file) }
})

/** Record a discovery answer. A failed write is only logged: the answer in hand is still used. */
export const writeMcpConfigCache = Effect.fn("Jolli.writeMcpConfigCache")(function* (
  request: GatewayRequest,
  mcp: Readonly<Record<string, unknown>>,
) {
  const file = mcpConfigCachePath(request)
  const written = yield* writeAtomically(file, JSON.stringify({ schema: MCP_CONFIG_SCHEMA, mcp }))
  if (written) yield* Effect.logWarning("Jolli: could not write the MCP discovery answer", { file, cause: written })
})

/** Forget this identity's answer, for when the backend says there is no MCP server to discover. */
export const dropMcpConfigCache = Effect.fn("Jolli.dropMcpConfigCache")(function* (request: GatewayRequest) {
  yield* Effect.promise(() => rm(mcpConfigCachePath(request), { force: true }).catch(() => {}))
})

/**
 * DROP THE SNAPSHOTS OF CREDENTIALS NOBODY IS USING ANY MORE. See {@link RETENTION}.
 *
 * ⚠ IT RIDES ON A REFRESH RATHER THAN ON A TIMER, because a refresh is the only moment this module
 * is reliably awake and already holding the lock — one sweep per TTL per tenant, against a
 * directory that holds a handful of files. A sweep of its own would need a schedule, an owner and
 * a reason not to run in every process at once.
 *
 * ⚠ AND IT NEVER FAILS OR RAISES. It is housekeeping attached to a fetch that succeeded; a cache
 * directory that will not list or will not delete is not a reason to throw away the catalogue the
 * caller asked for. The `.tmp` siblings a crashed write leaves behind carry the same prefix and
 * are collected by the same pass.
 */
const sweepOrphans = (keep: string) =>
  Effect.promise(async () => {
    const dir = path.dirname(keep)
    const cutoff = Date.now() - Duration.toMillis(RETENTION)
    const entries = await readdir(dir).catch(() => [] as string[])
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith(PREFIX))
        .map((entry) => path.join(dir, entry))
        .filter((target) => target !== keep)
        .map(async (target) => {
          const info = await stat(target).catch(() => undefined)
          if (!info || info.mtimeMs > cutoff) return
          await rm(target, { force: true }).catch(() => {})
        }),
    )
  })

/**
 * The catalogue, however it can be had.
 *
 * Fresh cache wins outright unless {@link LoadOptions.fresh} is set; otherwise a fetch is attempted and its failure falls back to whatever
 * is on disk, however old. Only a failure with nothing behind it is `unreachable`.
 */
/**
 * ⚠ IT BRINGS ITS OWN HTTP CLIENT RATHER THAN ASKING FOR ONE. The first caller is config loading,
 * whose effect context has no `HttpClient` — threading one through would mean widening
 * `InstanceContext` for a single optional fetch. `FetchHttpClient` is the same `fetch` the rest of
 * the process uses, so the sidecar's global proxy and certificate setup (`sidecar.ts`) still apply.
 */
export interface LoadOptions {
  /** How long a refresh may take before the stale copy wins. Defaults to {@link REFRESH_DEADLINE}. */
  readonly timeout?: Duration.Input
  /**
   * Ask the gateway even when the snapshot is within its TTL.
   *
   * ⚠ FOR A STUDENT WHO HAS JUST BEEN TOLD THE SNAPSHOT IS WRONG. A Start refused because an
   * assistant's window closed, or a picker opened to choose again, re-asks precisely because what
   * is on screen may be out of date — and a five-minute-old snapshot answering that re-ask hands
   * back the closed assistant, so the draft never moves off it. Only the "fresh cache wins"
   * shortcuts are skipped: the lock, the deadline, the stale-if-error fallback and the sweep all
   * still apply, so an offline student still gets their snapshot.
   */
  readonly fresh?: boolean
}

const loadCatalogEffect = Effect.fn("Jolli.loadCatalog")(function* (request: GatewayRequest, options?: LoadOptions) {
  const file = catalogCachePath(request)
  const requested = Date.now()
  if (!options?.fresh && (yield* isFresh(file))) {
    const cached = yield* readSnapshot(file)
    if (cached && (yield* stands(file, cached)))
      return { kind: "ok", snapshot: cached, stale: !isComplete(cached) } satisfies CatalogLoad
  }
  // Cross-process: the desktop's main process and its sidecar can arrive here together.
  const refreshed = yield* Effect.scoped(
    Effect.gen(function* () {
      yield* Flock.effect(`jolli-catalog:${file}`)
      /**
       * Another process may have refreshed while we waited for the lock. A caller asking past the
       * cache takes that answer only when its fetch began no earlier than its own request: one that
       * began before may predate whatever made the caller ask, but one since is exactly what it
       * asked for, and refetching it again is how queued refreshes each cost a full gateway load.
       *
       * ⚠ SINCE-REQUESTED STANDS EVEN WHEN SOME ORG DID NOT ANSWER IT. That org was asked as late
       * as this caller would ask it; the answer goes back marked stale rather than asked for again.
       */
      const cached = yield* readSnapshot(file)
      if (cached && (cached.fetchedAt ?? Number.NEGATIVE_INFINITY) >= requested) return cached
      if (!options?.fresh && cached && (yield* stands(file, cached))) return cached
      // Spaces the next retry from this attempt, which a caller's deadline may cut off unwritten. See RETRY.
      if (cached && !isComplete(cached)) yield* touch(file)
      return yield* refreshCatalog(request)
    }),
  ).pipe(
    Effect.map((snapshot) => ({ ok: true as const, snapshot })),
    Effect.catch((error: JolliApiError) => Effect.succeed({ ok: false as const, error })),
    // ⚠ OUTSIDE THE HANDLER ABOVE, so it bounds the lock wait as well as the fetch. See REFRESH_DEADLINE.
    Effect.timeout(options?.timeout ?? REFRESH_DEADLINE),
    /**
     * ⚠ DEFECTS ARE CAUGHT TOO, AND `Flock` IS WHY. It wraps acquire and release in
     * `Effect.promise`, so a lock timeout or a compromised lock arrives as a DEFECT rather than a
     * typed failure — straight past the handler above and out through every fallback this module
     * documents. Two callers make that fatal rather than merely wrong: config loading, where a
     * defect stops the server starting, and `createSidecarEnv()`, where it stops the sidecar
     * forking at all. A catalogue is never worth either.
     */
    Effect.catchCause((cause) =>
      Effect.succeed({
        ok: false as const,
        error: new JolliApiError({ path: file, message: `Jolli catalogue refresh failed: ${cause}` }),
      }),
    ),
  )

  // Some org's courses are as old as its last answer: the whole catalogue does not get to read as fresh.
  if (refreshed.ok)
    return { kind: "ok", snapshot: refreshed.snapshot, stale: !isComplete(refreshed.snapshot) } satisfies CatalogLoad

  const stale = yield* readSnapshot(file)
  if (stale) {
    yield* Effect.logDebug("Jolli: serving a stale catalogue", { error: refreshed.error })
    // The error travels with the answer rather than only into the log — see `CatalogLoad`.
    return { kind: "ok", snapshot: stale, stale: true, error: refreshed.error } satisfies CatalogLoad
  }
  return { kind: "unreachable", error: refreshed.error } satisfies CatalogLoad
})

export const loadCatalog = (request: GatewayRequest, options?: LoadOptions) =>
  loadCatalogEffect(request, options).pipe(Effect.provide(FetchHttpClient.layer))

/**
 * THE SNAPSHOT ON DISK FOR THIS CREDENTIAL, HOWEVER OLD, WITHOUT ASKING THE GATEWAY; undefined when
 * there is none. For a check that something a student is waiting on must not be held up by.
 */
export const readCatalog = (request: GatewayRequest) => readSnapshot(catalogCachePath(request))

/**
 * DROP EVERY CACHED CATALOGUE ON THIS MACHINE.
 *
 * ⚠ IT TAKES NO REQUEST, DELIBERATELY. The caller is signing out, and the point is that the next
 * person at this keyboard finds nothing — a snapshot keyed by a token nobody holds any more is
 * still one student's course list sitting in a directory the next student's account can read. That
 * is the same shared-bench case the key itself is built around; see {@link cachePath}.
 *
 * ⚠ AND IT NEVER FAILS. Sign-out has already happened by the time this runs, and a cache file that
 * would not delete is not a reason to tell somebody their sign-out did not work.
 */
export const clearCatalogCache = Effect.fn("Jolli.clearCatalogCache")(function* () {
  yield* Effect.promise(async () => {
    const entries = await readdir(Global.Path.cache).catch(() => [] as string[])
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith(PREFIX))
        .map((entry) => rm(path.join(Global.Path.cache, entry), { force: true }).catch(() => {})),
    )
  })
})
