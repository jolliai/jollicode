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
 * unusable on a train; `stale-if-error` is the rule, and {@link loadCatalog} reports the refresh
 * that failed beside the snapshot it left standing (`CatalogLoad.error`) rather than hiding it.
 */
import { readdir, rename, rm, stat, readFile, mkdir, utimes, writeFile } from "node:fs/promises"
import path from "path"
import { Duration, Effect, Exit, Fiber } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Global } from "../global"
import { Flock } from "../util/flock"
import { Hash } from "../util/hash"
import {
  fetchAssistantChoices,
  fetchCourses,
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
 * whole refresh. Retried on every read, each message would start another whole-catalogue load
 * against an org that is not going to answer it.
 *
 * ⚠ FROM THE ATTEMPT, BECAUSE AN ATTEMPT MAY WRITE NOTHING. One that fails leaves no snapshot behind,
 * and one still waiting out a slow org has not written yet; spacing retries by the file's last write
 * would let every caller past the window start another. `loadCatalog` touches the snapshot as it
 * begins one instead — before it forks one to run behind the caller, so the reads that arrive while
 * that one waits on the lock or a slow org do not each fork another.
 *
 * ⚠ AND NOBODY WAITS FOR IT, WITHIN THE TTL OF THE ANSWER. Past this window, the snapshot still
 * answers and the retry runs behind the caller — the orgs that did answer are as recent as a complete
 * snapshot's, and the one that did not is likely to time out again, which a guardrail check would
 * otherwise wait out on a student's message once a minute.
 *
 * ⚠ THE TTL OF THE ANSWER, NOT OF THE FILE. Each attempt touches the file, so a retry that keeps
 * failing — a revoked sign-in, a gateway gone — would keep it inside its TTL for ever, and nobody
 * would ever wait for a refresh and see what it failed with. Counted from `fetchedAt`, such a
 * snapshot stops answering unasked when a complete one would.
 *
 * ⚠ IT DOUBLES WITH EACH INCOMPLETE ANSWER IN A ROW, UP TO THE TTL — see {@link retryWindow}. An org
 * that stays down, or a course whose assistants keep failing, would otherwise cost a whole-catalogue
 * load every minute for as long as the student is active.
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
 *
 * ⚠ A CALLER'S SHORTER DEADLINE ONLY STOPS IT WAITING. The refresh runs on to this one and writes
 * what it fetched; cut off with the caller, a refresh slower than the guardrail check's five seconds
 * would never land, and every check would start it again.
 */
const REFRESH_DEADLINE = Duration.seconds(45)

/**
 * HOW LONG THE CATALOGUE LOCK OF A PROCESS THAT HAS GONE AWAY HOLDS OTHERS OFF.
 *
 * ⚠ A REFRESH CAN BE CUT OFF HOLDING IT, BECAUSE IT RUNS BEHIND ITS CALLER — see
 * {@link REFRESH_DEADLINE}. The bare CLI `process.exit()`s as soon as its command is done, and a
 * refresh still under way then leaves its lock directory on disk with no release coming. `Flock`'s
 * own default treats a lock as abandoned after a minute, which is a minute in which the desktop's
 * main process and its sidecar fall back to their stale snapshot on every read. A holder that is
 * alive keeps the lock by its heartbeat — `Flock` beats at a third of this — so the shorter window
 * costs a live refresh nothing.
 */
const LOCK_STALE = Duration.seconds(10)

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
 * Bumped to 4 when a snapshot without `home` came to mean the home-only list, with bare ids. One
 * schema 3 wrote without `home` named every course by its org, home's included; read as the new
 * meaning, a session bound to home course "7" finds only "acme:cs:7", and the assistants carried
 * forward stay keyed under ids no lookup asks for. `assistantsKept` and `incompleteRuns` arrived
 * with it, both optional.
 *
 * ⚠ SO A SCHEMA 3 SNAPSHOT THAT NAMES HOME IS STILL READ. Only one without `home` changed meaning;
 * one with it is keyed exactly as this build keys it. Refused too, every student's first launch after
 * the upgrade would find nothing on disk, and an offline one would get no courses and no models —
 * the opposite of the `stale-if-error` this file is built on. See {@link readSnapshot}.
 *
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
export const CATALOG_SCHEMA = 4

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
   * ⚠ A SNAPSHOT THAT HAS ANY IS ASKED AGAIN AFTER {@link RETRY} RATHER THAN THE TTL, and answers
   * meanwhile — see there.
   */
  readonly unavailable?: readonly OrgRef[]
  /**
   * The courses, by the id `assistants` is keyed with, whose assistants this fetch could not list
   * for any reason but a 404, and which carry the last snapshot's list instead. Absent when none.
   *
   * ⚠ THEY MAKE THE SNAPSHOT INCOMPLETE, exactly as an org in {@link unavailable} does. A list kept
   * from the last answer is as old as that answer; written as complete, it would stand the whole
   * TTL — a fresh ask after a refused Start would get back the assistant it was refused, and keep it
   * for five minutes rather than {@link RETRY}'s one.
   */
  readonly assistantsKept?: readonly string[]
  /**
   * How many refreshes in a row, this one included, answered incomplete. Absent on a complete
   * snapshot. It spaces the next retry — see {@link retryWindow}.
   */
  readonly incompleteRuns?: number
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
      /**
       * What the refresh that would have replaced this snapshot failed with, when it did and the
       * snapshot is the one it left standing.
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
  // A shape we no longer understand is the same as no cache: refetch rather than guess. A schema 3
  // snapshot that names home is a shape we do understand — see CATALOG_SCHEMA.
  if (value.schema !== CATALOG_SCHEMA && !(value.schema === 3 && value.home)) return undefined
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
 * THE COURSE LIST: FROM EVERY ORG WHEN THE SERVER NAMES HOME, FROM HOME ALONE WHEN IT CANNOT.
 *
 * ⚠ AN ANSWER WITHOUT `home` IS NOT READ. Which org is home decides every home course's id, so read
 * without it each "7" would become "tenant:org:7" — every session bound to a home course reading as
 * bound to a course that is gone, and coming back the day the server began naming home. A server that
 * predates `home`, or `/api/me/courses` itself (a 404), is asked for the home-only list instead: the one
 * every build before cross-org courses read, with the same bare ids.
 *
 * ⚠ NO OTHER ORG'S COURSE IS LOST BY IT. jolliedu began naming `home` in the same change that let a
 * CLI token send an org scope at all; a server without `home` refuses every scoped request from this
 * client, so a course in another org could be listed there but never asked about or started.
 *
 * ⚠ UNLESS THE LAST SNAPSHOT NAMED HOME, BOTH ARE ASKED AT ONCE. Asked in turn, a refresh against a
 * server without `home` would first wait out the cross-org fan-out — up to jolliedu's five seconds for
 * a slow org, the whole of a guardrail check's budget — for an answer it then threw away. That covers
 * the cold start too, with nothing on disk to say which server this is: it is the load that sits
 * under `STARTUP_DEADLINE`, and every student's first after a schema bump. A server that does name
 * home pays one home-only list for it, once; after that the snapshot names home and only the
 * cross-org list is asked.
 */
const listCourses = Effect.fn("Jolli.listCourses")(function* (
  request: GatewayRequest,
  previous: CatalogSnapshot | undefined,
) {
  const crossOrg = fetchMyCourses(request).pipe(
    Effect.catchIf(
      (error) => error.status === 404,
      () => Effect.succeed(undefined),
    ),
  )
  if (previous?.home) {
    const mine = yield* crossOrg
    if (mine?.home) return { courses: mine.courses, unavailable: mine.unavailable ?? [], home: mine.home }
    return { courses: yield* fetchCourses(request), unavailable: [] as readonly OrgRef[], home: undefined }
  }
  /**
   * ⚠ BOTH AS ANSWERS RATHER THAN FAILURES. A server that names home must not fail on the home-only
   * list, and one that does not has no use for the cross-org list — a 500 or an answer that will not
   * decode there must not throw away the home-only list it is about to read. Only when neither can be
   * read does the refresh fail, with the cross-org list's error when that one failed.
   */
  const [mine, homeOnly] = yield* Effect.all([Effect.exit(crossOrg), Effect.exit(fetchCourses(request))], {
    concurrency: 2,
  })
  if (Exit.isSuccess(mine) && mine.value?.home)
    return { courses: mine.value.courses, unavailable: mine.value.unavailable ?? [], home: mine.value.home }
  if (Exit.isSuccess(homeOnly))
    return { courses: homeOnly.value, unavailable: [] as readonly OrgRef[], home: undefined }
  return yield* Effect.failCause(Exit.isFailure(mine) ? mine.cause : homeOnly.cause)
})

/**
 * Fetch the whole catalogue and write it down, carrying forward from the snapshot on disk.
 *
 * ⚠ FOR TESTS ONLY. It takes no lock; production refreshes go through `loadCatalog`, which holds the
 * cross-process one around {@link refreshFrom}.
 */
export const refreshCatalog = Effect.fn("Jolli.refreshCatalog")(function* (request: GatewayRequest) {
  return yield* refreshFrom(request, yield* readSnapshot(catalogCachePath(request)))
})

/**
 * {@link refreshCatalog} given the snapshot it replaces — which `loadCatalog` has just read under the lock.
 *
 * ⚠ ONE COURSE FAILING MUST NOT COST THE STUDENT THE REST. `assistant-choices` is mounted with
 * `treatAsNotFound`, so a course the viewer cannot read answers 404 exactly as a deleted one does —
 * indistinguishable, and a perfectly ordinary thing to meet in a list. Failing the batch would take
 * every other course down with it; an empty assistant list renders as "this course has no
 * assistants yet", which is a sentence a student can act on.
 *
 * ⚠ BUT ONLY A 404 SAYS THERE ARE NONE. Any other failure — a timeout, an org that is down — keeps the
 * course's last list, the trade `stale-if-error` makes for the whole catalogue. Emptied, a course in
 * an org too slow to answer would sit in the picker with no assistant to start. The snapshot names
 * each such course in `assistantsKept`, so it is asked again as soon as one missing an org would be.
 *
 * ⚠ EACH COURSE'S ASSISTANTS ARE ASKED FOR IN THE COURSE'S OWN ORG. Its numeric id means another
 * course in any other org, so an unscoped read of an org-B course reads home's course of that number.
 *
 * ⚠ THE MODELS ARE ASKED FOR ONCE, UNSCOPED. jolliedu serves one routing catalogue for the whole
 * deployment, so every org the student reaches grants out of the same Registry UUIDs.
 */
const refreshFrom = Effect.fn("Jolli.refreshFrom")(function* (
  request: GatewayRequest,
  previous: CatalogSnapshot | undefined,
) {
  const fetchedAt = Date.now()
  const file = catalogCachePath(request)
  const [listed, models] = yield* Effect.all([listCourses(request, previous), fetchModelIndex(request)], {
    concurrency: 2,
  })
  const home = listed.home
  /**
   * Its lists are keyed by ids its home decided were bare or scoped; under another home they name
   * other courses. ⚠ A HOME-ONLY SNAPSHOT IS THE EXCEPTION: every id in it is a bare home id, which
   * means the same course once the server names home — so the refresh that first sees `home` still
   * keeps a course's assistants when listing them fails.
   */
  const prior = previous && (!previous.home || sameOrg(previous.home, home)) ? previous : undefined
  const fetched = listed.courses.filter(isVisibleCourse)
  const answers = yield* Effect.forEach(
    fetched,
    (course) => {
      const org = addressOf(course, home)
      const id = orgScopedId(org, course.id)
      return fetchAssistantChoices(scopedRequest(request, org), course.id).pipe(
        Effect.map((choices) => ({ id, choices, kept: false })),
        Effect.catch((error) =>
          Effect.logDebug("Jolli: could not list a course's assistants", { course: id, error }).pipe(
            Effect.as(
              error.status === 404
                ? { id, choices: [] as readonly CourseAssistantChoice[], kept: false }
                : { id, choices: prior?.assistants[id] ?? [], kept: true },
            ),
          ),
        ),
      )
    },
    { concurrency: 6 },
  )
  const assistantsKept = answers.filter((answer) => answer.kept).map((answer) => answer.id)
  const incomplete = listed.unavailable.length > 0 || assistantsKept.length > 0
  const incompleteRuns = previous && !isComplete(previous) ? (previous.incompleteRuns ?? 1) + 1 : 1
  const kept = carriedForward(
    prior,
    home,
    listed.unavailable,
    new Set(listed.courses.map((course) => orgScopedId(addressOf(course, home), course.id))),
  )
  const snapshot: CatalogSnapshot = {
    schema: CATALOG_SCHEMA,
    courses: [...fetched, ...kept.courses],
    ...(home ? { home } : {}),
    assistants: { ...kept.assistants, ...Object.fromEntries(answers.map((answer) => [answer.id, answer.choices])) },
    models: Array.from(models.values()),
    ...(listed.unavailable.length > 0 ? { unavailable: listed.unavailable } : {}),
    ...(assistantsKept.length > 0 ? { assistantsKept } : {}),
    ...(incomplete ? { incompleteRuns } : {}),
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
 * the same trade `stale-if-error` makes for the whole catalogue — and retried sooner for the same
 * reason, through the snapshot's `unavailable`.
 *
 * ⚠ `prior` IS ONLY EVER A SNAPSHOT UNDER THE SAME HOME. Its assistants are keyed by ids its home
 * decided were bare or scoped, so a snapshot answered under another home is keyed in a form this one
 * does not read.
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
  prior: CatalogSnapshot | undefined,
  home: OrgRef | undefined,
  unavailable: readonly OrgRef[],
  listed: ReadonlySet<string>,
) {
  if (!prior || unavailable.length === 0) return { courses: [], assistants: {} }
  const courses = prior.courses
    .filter((course) => course.org && unavailable.some((org) => sameOrg(org, course.org)))
    .map((course) => ({ course, id: orgScopedId(addressOf(course, home), course.id) }))
    .filter((kept) => !listed.has(kept.id))
  return {
    courses: courses.map((kept) => kept.course),
    assistants: Object.fromEntries(
      courses.flatMap((kept) => (prior.assistants[kept.id] ? [[kept.id, prior.assistants[kept.id]]] : [])),
    ),
  }
}

/** Whether every org, and every course's assistants, answered the fetch behind a snapshot. One that did not is asked again sooner. */
const isComplete = (snapshot: CatalogSnapshot) => !snapshot.unavailable?.length && !snapshot.assistantsKept?.length

/** Whether a snapshot may answer without asking: within its TTL, or within {@link RETRY} when some org did not answer. */
const stands = (file: string, snapshot: CatalogSnapshot) =>
  isFresh(file, isComplete(snapshot) ? TTL : retryWindow(snapshot))

/**
 * {@link RETRY}, doubled for each incomplete answer before this one in a row and capped at the TTL:
 * one minute, then two, four, and five from there on. A snapshot from before `incompleteRuns` counts
 * as the first.
 */
const retryWindow = (snapshot: CatalogSnapshot) =>
  Duration.min(Duration.times(RETRY, 2 ** ((snapshot.incompleteRuns ?? 1) - 1)), TTL)

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
  /**
   * How long this caller waits for a refresh before the stale copy answers it. Defaults to
   * {@link REFRESH_DEADLINE}.
   *
   * ⚠ IT BOUNDS THE WAIT, NOT THE REFRESH. The refresh runs on, holding the cross-process lock, until
   * it writes or {@link REFRESH_DEADLINE} stops it — see there.
   */
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

/**
 * WHAT THE LAST FAILED REFRESH OF EACH SNAPSHOT IN THIS PROCESS FAILED WITH, FOR WHICH TOKEN, AND
 * WHEN. Never cleared: a snapshot fetched since it outranks it — see {@link failureOver}.
 *
 * ⚠ IT EXISTS FOR THE REFRESH NOBODY WAITED FOR. One that runs behind its caller has no caller left
 * to hand a 401 to, and the 401 is what `/jolli/course` renews the sign-in on; dropped, a revoked
 * credential would go unnoticed behind a snapshot that kept answering. So the next read of that
 * snapshot carries it — see `CatalogLoad.error`.
 *
 * ⚠ ONLY FOR THE SAME TOKEN, AND ONLY OVER A SNAPSHOT FETCHED BEFORE IT. The renewal that a 401 sets
 * off mints a new token; reported to it, the old refusal would renew again on every read. And a
 * snapshot another process fetched since answers for itself.
 */
const lastFailure = new Map<string, { readonly token: string; readonly at: number; readonly error: JolliApiError }>()

/** {@link lastFailure}'s error, if it still stands over `snapshot` for this request. */
const failureOver = (file: string, request: GatewayRequest, snapshot: CatalogSnapshot) => {
  const failed = lastFailure.get(file)
  if (!failed || failed.token !== request.token) return undefined
  if ((snapshot.fetchedAt ?? Number.NEGATIVE_INFINITY) >= failed.at) return undefined
  return failed.error
}

/** A refresh that failed or ran out of time, as the answer `loadCatalog` falls back from. */
const refreshFailed = (file: string, cause: unknown) => ({
  ok: false as const,
  error: new JolliApiError({ path: file, message: `Jolli catalogue refresh failed: ${cause}` }),
})

/**
 * One refresh under the cross-process lock, as an answer rather than a failure.
 *
 * ⚠ BOUNDED BY {@link REFRESH_DEADLINE} ALONE, NEVER BY A CALLER'S. It runs detached from whoever
 * started it, so a caller that stops waiting leaves it to finish and write — see there.
 *
 * ⚠ AND IT OUTLIVES THE `FetchHttpClient` LAYER `loadCatalog` PROVIDES, whose scope closes when the
 * caller's effect returns. That is safe only because the layer has no finalizer to run. A client
 * with one — a pooled connection, say — would be torn down under a refresh still using it, so such a
 * client has to be provided from a scope that outlives this fiber.
 */
const refreshLocked = (request: GatewayRequest, file: string, ask: RefreshAsk) =>
  // Cross-process: the desktop's main process and its sidecar can arrive here together.
  Effect.scoped(
    Effect.gen(function* () {
      yield* Flock.effect(`jolli-catalog:${file}`, { staleMs: Duration.toMillis(LOCK_STALE) })
      /**
       * Another process may have refreshed while we waited for the lock. A caller asking past the
       * cache takes that answer only when its fetch began no earlier than `ask.since`: one that
       * began before may predate whatever made the caller ask, but one since is exactly what it
       * asked for, and refetching it again is how queued refreshes each cost a full gateway load.
       *
       * ⚠ SINCE-REQUESTED STANDS EVEN WHEN SOME ORG DID NOT ANSWER IT. That org was asked as late
       * as this caller would ask it; the answer goes back as it is rather than asked for again.
       */
      const cached = yield* readSnapshot(file)
      if (cached && (cached.fetchedAt ?? Number.NEGATIVE_INFINITY) >= ask.since) return cached
      if (!ask.fresh && cached && (yield* stands(file, cached))) return cached
      // Spaces the next retry from this attempt, which may write nothing. See RETRY.
      if (cached && !isComplete(cached)) yield* touch(file)
      return yield* refreshFrom(request, cached)
    }),
  ).pipe(
    Effect.map((snapshot) => ({ ok: true as const, snapshot })),
    Effect.catch((error: JolliApiError) => Effect.succeed({ ok: false as const, error })),
    // ⚠ OUTSIDE THE HANDLER ABOVE, so it bounds the lock wait as well as the fetch. See REFRESH_DEADLINE.
    Effect.timeout(REFRESH_DEADLINE),
    /**
     * ⚠ DEFECTS ARE CAUGHT TOO, AND `Flock` IS WHY. It wraps acquire and release in
     * `Effect.promise`, so a lock timeout or a compromised lock arrives as a DEFECT rather than a
     * typed failure — straight past the handler above and out through every fallback this module
     * documents. Two callers make that fatal rather than merely wrong: config loading, where a
     * defect stops the server starting, and `createSidecarEnv()`, where it stops the sidecar
     * forking at all. A catalogue is never worth either.
     */
    Effect.catchCause((cause) => Effect.succeed(refreshFailed(file, cause))),
    Effect.tap((result) =>
      Effect.sync(() => {
        if (!result.ok) lastFailure.set(file, { token: request.token, at: ask.requested, error: result.error })
      }),
    ),
  )

/**
 * What a refresh will take for an answer, besides one it fetches itself.
 *
 * - `requested`: when the caller asked, which a failure is remembered from — see {@link lastFailure}.
 * - `since`: a snapshot whose fetch began no earlier answers it.
 * - `fresh`: whether a snapshot that merely still stands — see {@link stands} — does not.
 */
type RefreshAsk = { readonly requested: number; readonly since: number; readonly fresh: boolean }

type Refreshed =
  | { readonly ok: true; readonly snapshot: CatalogSnapshot }
  | { readonly ok: false; readonly error: JolliApiError }

/**
 * THE REFRESH OF EACH SNAPSHOT RUNNING IN THIS PROCESS THAT ANY LATER CALLER MAY SHARE.
 *
 * ⚠ ONE AT A TIME, BECAUSE A REFRESH NO LONGER ENDS WITH ITS CALLER. With the gateway slow or down,
 * a guardrail check on every message would otherwise fork a refresh of its own, each queued on the
 * lock for up to {@link REFRESH_DEADLINE}; a failure writes nothing, so every one of them would load
 * the whole catalogue again, and a launch asking meanwhile would wait out its whole deadline behind
 * them. A caller that will take any answer newer than the snapshot it has joins the one running.
 *
 * ⚠ NOT A FRESH ASK. It wants a fetch that began after it asked, which one already running may not be.
 */
const shared = new Map<string, Fiber.Fiber<Refreshed>>()

/** {@link refreshLocked}, joining the {@link shared} refresh of `file` when one is running. */
const refreshShared = Effect.fn("Jolli.refreshShared")(function* (
  request: GatewayRequest,
  file: string,
  ask: RefreshAsk,
) {
  const running = shared.get(file)
  if (running) return running
  const fiber = yield* Effect.forkDetach(refreshLocked(request, file, ask))
  shared.set(file, fiber)
  // Registered only once the fiber is in the map, so it cannot remove an entry it never made.
  fiber.addObserver(() => {
    if (shared.get(file) === fiber) shared.delete(file)
  })
  return fiber
})

const loadCatalogEffect = Effect.fn("Jolli.loadCatalog")(function* (request: GatewayRequest, options?: LoadOptions) {
  const file = catalogCachePath(request)
  const requested = Date.now()
  if (!options?.fresh && (yield* isFresh(file))) {
    const cached = yield* readSnapshot(file)
    if (cached && (yield* stands(file, cached)))
      return { kind: "ok", snapshot: cached, error: failureOver(file, request, cached) } satisfies CatalogLoad
    // Some org did not answer it and its retry is due: within the answer's TTL the retry runs behind
    // this answer, marked as begun first so the reads meanwhile do not each start one. See RETRY.
    // ⚠ Answered by any snapshot newer than this one, not by one that stands: that mark makes this
    // one stand again, while a snapshot another process wrote since is the retry already done.
    const answeredAt = cached?.fetchedAt ?? Number.NEGATIVE_INFINITY
    if (cached && requested - answeredAt < Duration.toMillis(TTL)) {
      yield* touch(file)
      yield* refreshShared(request, file, { requested, since: answeredAt + 1, fresh: true })
      return { kind: "ok", snapshot: cached, error: failureOver(file, request, cached) } satisfies CatalogLoad
    }
  }
  // Detached, so this caller's deadline stops only its own wait. See REFRESH_DEADLINE.
  const ask = { requested, since: requested, fresh: options?.fresh ?? false }
  const attempt = ask.fresh
    ? yield* Effect.forkDetach(refreshLocked(request, file, ask))
    : yield* refreshShared(request, file, ask)
  const refreshed = yield* Fiber.join(attempt).pipe(
    Effect.timeout(options?.timeout ?? REFRESH_DEADLINE),
    Effect.catchCause((cause) => Effect.succeed(refreshFailed(file, cause))),
  )
  // An answer the lock found standing rather than fetched may still be behind a retry that failed.
  if (refreshed.ok)
    return {
      kind: "ok",
      snapshot: refreshed.snapshot,
      error: failureOver(file, request, refreshed.snapshot),
    } satisfies CatalogLoad

  const stale = yield* readSnapshot(file)
  if (stale) {
    yield* Effect.logDebug("Jolli: serving a stale catalogue", { error: refreshed.error })
    // The error travels with the answer rather than only into the log — see `CatalogLoad`.
    return { kind: "ok", snapshot: stale, error: refreshed.error } satisfies CatalogLoad
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
  // With the snapshots gone, nothing fetched since can outrank a remembered failure — see `lastFailure`.
  lastFailure.clear()
  yield* Effect.promise(async () => {
    const entries = await readdir(Global.Path.cache).catch(() => [] as string[])
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith(PREFIX))
        .map((entry) => rm(path.join(Global.Path.cache, entry), { force: true }).catch(() => {})),
    )
  })
})
