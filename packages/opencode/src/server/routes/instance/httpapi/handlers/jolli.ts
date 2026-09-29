/**
 * ⚠ THE MAPPING HAPPENS HERE SO THE RENDERER NEVER MEETS THE GATEWAY'S SHAPES. Registry UUIDs,
 * vendor groupings, the `viewerRole` an institution administrator gets on courses that are not
 * theirs — none of that is a screen's business. What crosses this boundary is a course, its
 * assistants, and whether a session may start.
 *
 * ⚠ AND NO CREDENTIAL IS AN EMPTY CATALOGUE, NOT AN ERROR. The renderer asks for this on every
 * session screen, including before the student has signed in; an error there would surface as a
 * failed request on a screen whose own empty state already says the right thing.
 */
import {
  fetchConversationShares,
  fetchConversationVisibility,
  fetchCourseMembers,
  shareConversation,
  unshareConversation,
  type ConversationVisibility,
  type JolliApiError,
} from "@opencode-ai/core/jolli/api"
import { loadCatalog } from "@opencode-ai/core/jolli/cache"
import { projectCatalog, today } from "@opencode-ai/core/jolli/catalog"
import { viewerFromToken } from "@opencode-ai/core/jolli/identity"
import { JolliSession } from "@opencode-ai/core/jolli/session"
import { classSizeOf, projectMembers, projectReaders, refusalOf, WRITABLE_ACCESS } from "@opencode-ai/core/jolli/share"
import { Jolli } from "@opencode-ai/schema/jolli"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"

/**
 * ⚠ EVERY EMPTY ANSWER HERE IS `unreachable`, NOT `ok` WITH NOTHING IN IT. Each branch below is a
 * question we never got to ask — no credential, no tenant, an origin we refuse to send a token to,
 * a gateway that did not answer. Only a catalogue the gateway actually returned is `ok`, and only
 * then does an empty `courses` mean "you are enrolled in nothing". See `Jolli.CatalogStatus`.
 */
const UNREACHABLE = { status: "unreachable" as const, courses: [], assistants: [], modelTiers: {} }

/**
 * A share answer with nothing in it. Same rule as {@link UNREACHABLE}: every status but `ok` is a
 * question that got no usable answer, so the renderer keeps what it already had rather than
 * reading these empty arrays as "nobody can read this".
 */
const shareAnswer = (status: Jolli.ShareStatus): Jolli.SessionShare => ({
  status,
  courseId: null,
  courseCode: null,
  readers: [],
  members: [],
  classSize: 0,
  roster: "unavailable",
})

export const jolliHandlers = HttpApiBuilder.group(RootHttpApi, "jolli", (handlers) =>
  Effect.gen(function* () {
    const session = yield* JolliSession.Service

    const course = Effect.fn("JolliHttpApi.course")(function* () {
      /**
       * WHO IS SIGNED IN, DECIDED BEFORE WE ASK WHETHER THE GATEWAY IS REACHABLE.
       *
       * ⚠ THAT ORDER IS THE POINT, NOT AN ACCIDENT OF WHERE THE LINE FITS. Identity is derivable
       * from the stored token alone, so gating it behind the reachability guard below would blank a
       * student's own name because their Wi-Fi dropped — or, worse, because their credential has no
       * `base_url` and `request()` therefore answers nothing while holding a perfectly good token.
       *
       * ⚠ THE POLLED READ, NOT THE REFRESHING ONE, AND THAT IS THE SAME ARGUMENT AGAIN. `current()`
       * never touches the network, so a name on screen cannot depend on a refresh round trip; the
       * gateway call below is the only thing entitled to need a fresh token.
       *
       * ⚠ SPREAD INTO EVERY RETURN, NEVER MUTATED INTO `UNREACHABLE`. That constant is shared by
       * all three branches; writing to it would leak one request's viewer into the next one's answer.
       */
      const credential = yield* session.current()
      const viewer = credential ? viewerFromToken(credential.access_token) : undefined
      /**
       * ⚠ THE ROW'S OWN COLUMNS, NOT THE TOKEN'S CLAIMS, AND NOT `cache_key`. See
       * `Jolli.Catalog.account`: the subject is what the credential row is keyed by and is the only
       * thing here that survives a sign-out and names the same student on the way back in. The
       * address is the fallback for a backend that reports no subject; when there is neither, the
       * field is omitted and the client is told, in the only way this protocol can, that it cannot
       * tell one account from another.
       */
      const account = credential?.subject ?? credential?.email ?? undefined
      const identity = { ...(viewer ? { viewer } : {}), ...(account ? { account } : {}) }

      /**
       * ⚠ THE REFRESHING READ, NOT THE POLLED ONE. This is a real gateway call, so it needs a token
       * that will still be valid when it lands — unlike `connected`, which is polled and must never
       * touch the network. Signed out, unreachable and rate-limited all answer the same way here:
       * a question we never got to ask.
       */
      const request = yield* session.request().pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!request) return { ...UNREACHABLE, ...identity }

      const loaded = yield* loadCatalog(request)
      /**
       * ⚠ A 401 IS NOT AN OUTAGE, AND THIS IS THE STUDENT WHO NEVER SENDS A MESSAGE. The model
       * path reaches `refused` on its own, but somebody who only opens the app would otherwise
       * sit in front of a course list they cannot use until their token expired — up to three days
       * of being told nothing is reachable while the real answer is that the sign-in ended.
       * Renewing settles it either way: a live credential comes back with a working token on the
       * next poll, a finished one is deleted here and the app asks them to sign in.
       *
       * ⚠ BEFORE THE `ok` CHECK, NOT INSIDE THE FAILURE BRANCH, AND THAT IS THE WHOLE FIX. A
       * refusal that has a snapshot behind it is answered `ok` with `stale` set (`cache.ts` serves
       * what it has rather than failing), so a check that only ran on `unreachable` renewed for the
       * student with an empty cache and never for the one who had been using the product — whose
       * screen looked entirely normal while the credential behind it was dead.
       *
       * The answer is not consulted and the failure is swallowed on purpose. This request is
       * already decided — either the snapshot serves it or nothing does — and neither outcome
       * changes what it returns.
       */
      if (loaded.error?.status === 401) {
        yield* session.refused(request.token).pipe(Effect.catch(() => Effect.void))
      }
      if (loaded.kind !== "ok") {
        yield* Effect.logDebug("Jolli: catalogue unavailable, answering empty", { error: loaded.error })
        return { ...UNREACHABLE, ...identity }
      }
      /**
       * ⚠ `today` IS READ PER REQUEST, NOT PER CACHE WRITE. A course's `entryState` depends on the
       * date as much as on its own fields, so a snapshot cached last night must not be allowed to
       * assert this morning that a course is still running.
       */
      return { ...projectCatalog(loaded.snapshot, today()), ...identity }
    })

    /**
     * THE GATEWAY TO ASK, OR NOTHING WHEN WE CANNOT. Same refreshing read `course` makes, for the
     * same reason: these are real gateway calls.
     */
    const gateway = () => session.request().pipe(Effect.catch(() => Effect.succeed(undefined)))

    /**
     * ONE FAILED GATEWAY CALL, AS AN ANSWER.
     *
     * ⚠ 404 IS `unsynced`, NOT AN OUTAGE. jolliedu answers "not yours" and "not there" alike, and
     * for a session this student owns it means the first message has not reached the gateway yet.
     *
     * ⚠ A 401 RENEWS THE CREDENTIAL, as the catalogue route does — the swallowing is the same
     * decision for the same reason: this answer is already decided either way.
     */
    const failed = Effect.fn("JolliHttpApi.shareFailed")(function* (error: JolliApiError, token: string) {
      if (error.status === 401) yield* session.refused(token).pipe(Effect.catch(() => Effect.void))
      if (error.status === 404) return shareAnswer("unsynced")
      if (error.status === 400) return { ...shareAnswer("refused"), refusal: refusalOf(error.code) }
      /**
       * ⚠ A GATEWAY THAT ANSWERED IS LOGGED LOUDER THAN ONE THAT DID NOT. Both reach the student as
       * `unreachable`, so the status in this line is the only place a 403 or a 5xx can be told apart
       * from a dropped connection.
       */
      yield* error.status === undefined
        ? Effect.logDebug("Jolli: share call failed", { error })
        : Effect.logWarning("Jolli: share call refused", { status: error.status, code: error.code })
      return shareAnswer("unreachable")
    })

    const answered = (
      visibility: ConversationVisibility,
      roster?: { members: Jolli.ShareMember[]; classSize: number },
    ): Jolli.SessionShare => ({
      status: "ok",
      courseId: visibility.courseId,
      courseCode: visibility.courseCode,
      readers: projectReaders(visibility),
      members: roster?.members ?? [],
      classSize: roster?.classSize ?? 0,
      roster: roster ? "ok" : "unavailable",
    })

    const share = Effect.fn("JolliHttpApi.share")(function* (ctx: { params: { sessionID: string } }) {
      const request = yield* gateway()
      if (!request) return shareAnswer("unreachable")
      const credential = yield* session.current()
      const viewer = credential ? viewerFromToken(credential.access_token) : undefined
      return yield* fetchConversationVisibility(request, ctx.params.sessionID).pipe(
        Effect.flatMap((visibility) => {
          if (visibility.courseId === null) return Effect.succeed(answered(visibility))
          /**
           * ⚠ AN UNREADABLE ROSTER EMPTIES THE PICKER, NOT THE PANEL. jolliedu's rule: the grants
           * already made are the half of this panel that matters most, and they came with the
           * conversation read that just succeeded.
           */
          return fetchCourseMembers(request, visibility.courseId).pipe(
            Effect.map((roster) =>
              answered(visibility, { members: projectMembers(roster, viewer?.email), classSize: classSizeOf(roster) }),
            ),
            // Logged, not surfaced: the panel says the roster is unavailable, and this says why.
            Effect.catch((error) =>
              Effect.logWarning("Jolli: course roster unavailable", {
                courseId: visibility.courseId,
                status: error.status,
              }).pipe(Effect.as(answered(visibility))),
            ),
          )
        }),
        Effect.catch((error) => failed(error, request.token)),
      )
    })

    /**
     * THE READERS ALONE — the header's share button, asked for every session it shows.
     *
     * ⚠ NO ROSTER AND NO TIMELINE. The button only says whether anybody else can read the session,
     * so this answers the way a write does and leaves `members` to the panel's full read.
     */
    const shareReaders = Effect.fn("JolliHttpApi.shareReaders")(function* (ctx: { params: { sessionID: string } }) {
      const request = yield* gateway()
      if (!request) return shareAnswer("unreachable")
      return yield* fetchConversationShares(request, ctx.params.sessionID).pipe(
        Effect.map((visibility) => answered(visibility)),
        Effect.catch((error) => failed(error, request.token)),
      )
    })

    const shareAdd = Effect.fn("JolliHttpApi.shareAdd")(function* (ctx: {
      params: { sessionID: string }
      payload: { subject: Jolli.ShareSubject }
    }) {
      // The schema admits any integer; the path route (`subjectOf`) admits only a real user id.
      if (ctx.payload.subject !== Jolli.EVERYONE && ctx.payload.subject <= 0)
        return { ...shareAnswer("refused"), refusal: "unknown" as const }
      const request = yield* gateway()
      if (!request) return shareAnswer("unreachable")
      return yield* shareConversation(request, ctx.params.sessionID, ctx.payload.subject, WRITABLE_ACCESS).pipe(
        Effect.map((visibility) => answered(visibility)),
        Effect.catch((error) => failed(error, request.token)),
      )
    })

    const shareRemove = Effect.fn("JolliHttpApi.shareRemove")(function* (ctx: {
      params: { sessionID: string; subject: string }
    }) {
      const subject = subjectOf(ctx.params.subject)
      if (subject === undefined) return { ...shareAnswer("refused"), refusal: "unknown" as const }
      const request = yield* gateway()
      if (!request) return shareAnswer("unreachable")
      return yield* unshareConversation(request, ctx.params.sessionID, subject).pipe(
        Effect.map((visibility) => answered(visibility)),
        Effect.catch((error) => failed(error, request.token)),
      )
    })

    return handlers
      .handle("course", course)
      .handle("share", share)
      .handle("shareReaders", shareReaders)
      .handle("shareAdd", shareAdd)
      .handle("shareRemove", shareRemove)
  }),
).pipe(
  /**
   * ⚠ THE GATEWAY CALLS' HTTP CLIENT, PROVIDED ONCE FOR THE GROUP rather than rebuilt per request.
   * The group captures its context when the layer is built and hands it to every handler.
   */
  Layer.provide(FetchHttpClient.layer),
)

/**
 * A SUBJECT OFF THE PATH: the class literal, or a positive user id. jolliedu's `toSubject`, with the
 * literal matched first because it is the only non-numeric value either route accepts.
 */
function subjectOf(value: string) {
  if (value === Jolli.EVERYONE) return Jolli.EVERYONE
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}
