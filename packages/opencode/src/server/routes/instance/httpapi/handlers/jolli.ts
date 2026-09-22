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
import { gatewayRequest } from "@opencode-ai/core/jolli/api"
import { loadCatalog } from "@opencode-ai/core/jolli/cache"
import { projectCatalog, today } from "@opencode-ai/core/jolli/catalog"
import { viewerFromToken } from "@opencode-ai/core/jolli/identity"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Auth } from "@/auth"
import { JOLLI_AUTH_KEY, jolliCredential } from "@/jolli/credential"
import { RootHttpApi } from "../api"

/**
 * ⚠ EVERY EMPTY ANSWER HERE IS `unreachable`, NOT `ok` WITH NOTHING IN IT. Each branch below is a
 * question we never got to ask — no credential, no tenant, an origin we refuse to send a token to,
 * a gateway that did not answer. Only a catalogue the gateway actually returned is `ok`, and only
 * then does an empty `courses` mean "you are enrolled in nothing". See `Jolli.CatalogStatus`.
 */
const UNREACHABLE = { status: "unreachable" as const, courses: [], assistants: [], modelTiers: {} }

export const jolliHandlers = HttpApiBuilder.group(RootHttpApi, "jolli", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* Auth.Service

    const course = Effect.fn("JolliHttpApi.course")(function* () {
      const stored = yield* auth.get(JOLLI_AUTH_KEY).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const credential = jolliCredential(stored)

      /**
       * WHO IS SIGNED IN, DECIDED BEFORE WE ASK WHETHER THE GATEWAY IS REACHABLE.
       *
       * ⚠ THAT ORDER IS THE POINT, NOT AN ACCIDENT OF WHERE THE LINE FITS. Identity is derivable
       * from the token alone, so gating it behind the reachability guards below would blank a
       * student's own name because their Wi-Fi dropped — or, worse, because their server predates
       * `baseUrl` and the very next line answers `UNREACHABLE` while holding a perfectly good
       * token.
       *
       * ⚠ SPREAD INTO EVERY RETURN, NEVER MUTATED INTO `UNREACHABLE`. That constant is shared by
       * all four branches; writing to it would leak one request's viewer into the next one's answer.
       */
      const viewer = credential ? viewerFromToken(credential.token) : undefined
      const identity = viewer ? { viewer } : {}

      if (!credential?.baseUrl) return { ...UNREACHABLE, ...identity }

      const request = gatewayRequest(credential.baseUrl, credential.token)
      if (!request) return { ...UNREACHABLE, ...identity }

      const loaded = yield* loadCatalog(request)
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

    return handlers.handle("course", course)
  }),
)
