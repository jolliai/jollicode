export * as JolliSession from "./session"

import { Cache, Clock, Context, Duration, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { Flock } from "../util/flock"
import { Hash } from "../util/hash"
import { gatewayRequest, type GatewayRequest } from "./api"
import { clearCatalogCache } from "./cache"
import { JolliRefreshError, refreshCliToken, type JolliCredentials } from "./exchange"
import { jolliAuthOrigin } from "./origin"
import { JolliStore } from "./store"

/** This credential is finished. The row is gone; the student has to sign in again. */
export class JolliSignedOut extends Schema.TaggedErrorClass<JolliSignedOut>()("Jolli.SignedOut", {
  message: Schema.String,
}) {}

/** We never got an answer. The row is intact and retrying later is the right move. */
export class JolliUnavailable extends Schema.TaggedErrorClass<JolliUnavailable>()("Jolli.Unavailable", {
  message: Schema.String,
}) {}

export type JolliSessionError = JolliSignedOut | JolliUnavailable

/**
 * Refresh this long before expiry, so a request never carries a token that dies mid-flight.
 * Same window `Integration.connection.resolve` and the console account both use.
 */
const eagerRefreshThresholdMs = Duration.toMillis(Duration.minutes(5))

/**
 * ⚠ `Flock` DEFAULTS TO FIVE MINUTES, WHICH IS UNUSABLE ON A REQUEST PATH. A student waiting on a
 * model call must not block for minutes because another process is wedged; running out here is an
 * "unavailable", not a sign-out.
 */
const lockTimeoutMs = 15_000

/**
 * ⚠ A NULL EXPIRY MEANS FRESH — THE OPPOSITE OF THE CONSOLE ACCOUNT'S RULE, ON PURPOSE. There, null
 * means "we do not know, go and find out". Here it means the backend issued a long-lived token and
 * sent no refresh token with it, so there is nothing to find out and nothing to refresh with.
 * Treating it as stale would fail every request on a backend that predates the triple.
 *
 * ⚠ WHICH IS ONLY SAFE BECAUSE NULL NEVER REACHES A ROW THAT HAS A REFRESH TOKEN — see
 * {@link expiryFor}. A row that could be renewed and claims to be fresh forever would never be.
 */
const isTokenFresh = (expiry: number | null, now: number) => expiry === null || expiry > now + eagerRefreshThresholdMs

/**
 * ⚠ AN UNSTATED LIFETIME ALONGSIDE A REFRESH TOKEN IS A GUESS, NOT "FOREVER". `expires_in` is
 * optional on the wire (`exchange.ts` tolerates every field independently), and a null expiry reads
 * as permanently fresh above — so a single response that omitted it would park the row outside the
 * refresh path for good and answer 401 from the moment the access token actually died. Nothing in
 * this service reacts to a 401; expiry is the only thing that triggers a renewal, which is what
 * makes that state terminal rather than merely wasteful. Guessing short costs an extra refresh an
 * hour, and `tolerate` already makes a failed one free while the token we hold still works.
 */
const assumedLifetimeMs = Duration.toMillis(Duration.hours(1))

/**
 * Absolute expiry for what a sign-in or a refresh reported, or undefined when the row genuinely has
 * nothing to renew with and the null-means-fresh rule above is the right reading.
 */
const expiryFor = (expiresIn: number | undefined, refreshToken: string | undefined, now: number) => {
  if (expiresIn !== undefined) return now + expiresIn * 1000
  return refreshToken ? now + assumedLifetimeMs : undefined
}

/**
 * THE DEVELOPER'S OVERRIDE, AND THE ONLY WAY A CREDENTIAL REACHES THIS SERVICE FROM OUTSIDE.
 *
 * ⚠ IT IS A DEVELOPMENT AFFORDANCE, NOT A PRODUCT PATH. `jolli/DEV.md` documents it as how you
 * point a hand-started `serve` at a real student's account; nothing the product ships sets it. The
 * desktop used to, which is why `createSidecarEnv()` scrubs both names — and why that scrub is now
 * a permanent part of the design rather than a transitional one: with the desktop no longer
 * overwriting them, an inherited `JOLLICODE_JOLLI_TOKEN` from a login shell would otherwise decide
 * which account the sidecar acts as.
 *
 * ⚠ THE CANONICAL PREFIX ONLY — no `OPENCODE_` fallback. A credential is the one thing that must
 * not have a second spelling an outer shell could set.
 */
export const JOLLI_TOKEN_ENV = "JOLLICODE_JOLLI_TOKEN"
export const JOLLI_BASE_URL_ENV = "JOLLICODE_JOLLI_BASE_URL"

/** The env names `createSidecarEnv()` scrubs before it forks the sidecar. */
export const JOLLI_CREDENTIAL_ENV = [JOLLI_TOKEN_ENV, JOLLI_BASE_URL_ENV] as const

/** The id `fromEnv` gives its synthetic row, which two callers have to recognise. */
const INJECTED_ROW_ID = "env"

/**
 * ⚠ A NULL EXPIRY AND NO REFRESH TOKEN, WHICH IS EXACTLY RIGHT. An injected token is whatever the
 * developer pasted; there is nothing to renew it with and no claim about when it dies, so it reads
 * as permanently fresh and never reaches the refresh path.
 */
const fromEnv = (): JolliStore.Row | undefined => {
  const token = process.env[JOLLI_TOKEN_ENV]?.trim()
  if (!token) return undefined
  const baseUrl = process.env[JOLLI_BASE_URL_ENV]?.trim()
  return {
    id: INJECTED_ROW_ID,
    subject: null,
    email: null,
    base_url: baseUrl || null,
    access_token: token,
    refresh_token: null,
    token_expiry: null,
    // Derived rather than random so a restart keeps reading the same catalogue snapshot.
    cache_key: Hash.fast(token),
    time_created: 0,
    time_updated: 0,
  }
}

export interface Interface {
  /** The stored credential, without ever touching the network. Safe on polled endpoints. */
  readonly current: () => Effect.Effect<JolliStore.Row | undefined>
  /** A usable access token, refreshing first when this one is close to expiry. */
  readonly token: () => Effect.Effect<string, JolliSessionError>
  /** A gateway request carrying a fresh token, or undefined when there is no usable tenant. */
  readonly request: () => Effect.Effect<GatewayRequest | undefined, JolliSessionError>
  /**
   * THE GATEWAY REFUSED THE TOKEN WE SENT. Renew once and answer with what replaces it.
   *
   * ⚠ THIS IS THE ONLY WAY A 401 EVER REACHES THE REFRESH PATH. Expiry is what normally triggers a
   * renewal, and expiry alone cannot see a token that was revoked while it was still young: the
   * backend refuses it the moment a password changes, and a client that waits for `exp` keeps
   * presenting it for the rest of its 72 hours — failing every request and never asking for a new
   * one, because by its own reckoning it is still signed in. Without a call here that state lasts
   * until five minutes before expiry.
   *
   * Pass the token that was refused. A renewal that has already happened elsewhere is answered
   * from the store instead of spending another one, which is what keeps a burst of parallel 401s
   * to a single rotation.
   *
   * Fails `Jolli.SignedOut` once the credential is finished — the row is gone by then and the
   * student has to sign in again, which is the outcome this exists to reach quickly.
   */
  readonly refused: (token: string) => Effect.Effect<string, JolliSessionError>
  /** Stores what a sign-in returned and makes it the active credential. */
  readonly signIn: (credentials: JolliCredentials) => Effect.Effect<JolliStore.Row>
  /** Forgets the credential and the catalogue snapshot that belongs to it. */
  readonly signOut: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/JolliSession") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* JolliStore.Service

    /** The environment outranks the database, and only a developer can set it. */
    const active = () =>
      Effect.suspend(() => {
        const injected = fromEnv()
        return injected ? Effect.succeed(injected) : store.active()
      })

    const forget = (row: JolliStore.Row) =>
      store.remove(row.id).pipe(
        Effect.andThen(clearCatalogCache),
        Effect.catchCause(() => Effect.void),
      )

    const rotate = (row: JolliStore.Row, refreshToken: string) =>
      Effect.gen(function* () {
        /**
         * ⚠ ALWAYS THE AUTH HUB, NEVER `row.base_url` — AND THE TENANT'S OWN ADDRESS IS THE REASON,
         * NOT AN OVERSIGHT.
         *
         * A tenant on a custom primary domain gets a `baseUrl` outside `isJolliOriginAllowed`'s
         * list, and `refreshCliToken` re-checks that list on every call. Refreshing against the
         * stored address would therefore refuse the tenants most likely to have one, and refuse
         * them as "unavailable" — so the session would not end, it would simply stop renewing and
         * die at expiry with no way back.
         *
         * Safe because the backend takes the tenant from the stored credential rather than from
         * the request (the row is the only thing a refresh carries), and because the hub already
         * serves this router: `exchangeCliCode` redeems against the same `/api/auth` mount.
         *
         * `base_url` keeps its other job — it is the gateway address every API call below uses.
         */
        const renewed = yield* Effect.tryPromise({
          try: () => refreshCliToken(jolliAuthOrigin(), refreshToken),
          catch: (cause) =>
            cause instanceof JolliRefreshError && cause.kind === "signed-out"
              ? new JolliSignedOut({ message: cause.message })
              : new JolliUnavailable({ message: cause instanceof Error ? cause.message : String(cause) }),
        })
        const now = yield* Clock.currentTimeMillis
        // A backend that does not rotate omits it, and the one we already hold stays valid.
        const renewedRefreshToken = renewed.refreshToken ?? row.refresh_token ?? undefined
        const expiry = expiryFor(renewed.expiresIn, renewedRefreshToken, now)
        yield* store.persistToken({
          id: row.id,
          accessToken: renewed.token,
          refreshToken: renewedRefreshToken,
          ...(expiry !== undefined ? { expiry } : {}),
          // Follows the tenant if it ever moves. Omitted when the refresh reported no address, which
          // keeps the one we already have rather than falling back to the hub for good.
          ...(renewed.baseUrl !== undefined ? { baseUrl: renewed.baseUrl } : {}),
        })
        return renewed.token
      })

    /**
     * ⚠ AN OUTAGE INSIDE THE EAGER WINDOW MUST NOT SIGN ANYBODY OUT. For the last five minutes of a
     * token's life `isTokenFresh` is false, so every request tries to refresh — and a single bad
     * minute upstream would otherwise end a student's session mid-assignment. While the token we
     * hold is still valid, an unavailable backend costs nothing.
     */
    const tolerate = (row: JolliStore.Row, effect: Effect.Effect<string, JolliSessionError>) =>
      effect.pipe(
        Effect.catchTag("Jolli.Unavailable", (error) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            if (row.token_expiry !== null && row.token_expiry > now) return row.access_token
            return yield* error
          }),
        ),
      )

    const renew = (row: JolliStore.Row) =>
      tolerate(
        row,
        Effect.gen(function* () {
          const refreshToken = row.refresh_token
          if (!refreshToken) {
            yield* forget(row)
            return yield* new JolliSignedOut({
              message: "Your Jolli session expired and there is nothing to renew it with. Please sign in again.",
            })
          }
          return yield* rotate(row, refreshToken).pipe(
            Effect.tapError((error) => (error._tag === "Jolli.SignedOut" ? forget(row) : Effect.void)),
          )
        }),
      )

    /**
     * ⚠ TWO LAYERS OF DEDUPLICATION, BECAUSE A SPENT REFRESH TOKEN CANNOT BE REPLAYED. The cache
     * coalesces concurrent callers inside this process; `Flock` coalesces the sidecar, a bare CLI
     * and anything else sharing the database. A lost race is not merely wasteful — the loser's
     * refresh token has already been retired by the server — so both re-read the row after winning
     * and hand back whatever the winner stored.
     *
     * @param answered Whether the row re-read under the lock already answers this caller, so the
     * renewal can be skipped. The two callers ask different questions of the same row: a caller
     * that renewed on EXPIRY is satisfied by a token that is fresh, while a caller whose token was
     * REFUSED is satisfied only by a DIFFERENT one — a refused token is usually still fresh by the
     * clock, so asking about freshness there would hand the dead token straight back.
     */
    const locked = (row: JolliStore.Row, answered: (latest: JolliStore.Row, now: number) => boolean) =>
      tolerate(
        row,
        Effect.scoped(
          Effect.gen(function* () {
            /**
             * ⚠ `Flock` REPORTS A LOCK TIMEOUT AS A DEFECT, NOT A TYPED FAILURE — it wraps acquire and
             * release in `Effect.promise`. Catching the cause here is the only way that lands as
             * "unavailable" rather than escaping every handler in this file. `cache.ts` makes the
             * same note for the same reason.
             */
            yield* Flock.effect(`jolli-refresh:${row.id}`, { timeoutMs: lockTimeoutMs }).pipe(
              Effect.catchCause(() =>
                Effect.fail(new JolliUnavailable({ message: "Another process is already renewing this session." })),
              ),
            )
            const latest = yield* store.active()
            if (!latest) return yield* new JolliSignedOut({ message: "Signed out while renewing the session." })
            const now = yield* Clock.currentTimeMillis
            if (answered(latest, now)) return latest.access_token
            return yield* renew(latest)
          }),
        ),
      )

    const cache = yield* Cache.make<string, string, JolliSessionError>({
      capacity: Number.POSITIVE_INFINITY,
      // Zero TTL: this caches nothing. It exists only so concurrent callers share one refresh.
      timeToLive: Duration.zero,
      lookup: Effect.fnUntraced(function* (id: string) {
        const row = yield* store.active()
        if (!row || row.id !== id) {
          return yield* new JolliSignedOut({ message: "Signed out while renewing the session." })
        }
        const now = yield* Clock.currentTimeMillis
        if (isTokenFresh(row.token_expiry, now)) return row.access_token
        return yield* locked(row, (latest, at) => isTokenFresh(latest.token_expiry, at))
      }),
    })

    const token = Effect.fn("JolliSession.token")(function* () {
      const row = yield* active()
      if (!row) return yield* new JolliSignedOut({ message: "Not signed in to Jolli." })
      const now = yield* Clock.currentTimeMillis
      if (isTokenFresh(row.token_expiry, now)) return row.access_token
      return yield* Cache.get(cache, row.id)
    })

    /**
     * ⚠ AN INJECTED CREDENTIAL IS REFUSED AND LEFT ALONE, THE SAME LINE `signOut` DRAWS. It is a
     * developer's paste with nothing to renew it and no row to delete. Reading the store instead
     * would be worse than pointless: with both an injected token and a stored sign-in present, the
     * stored row's token differs from the refused one, so the early return below would answer this
     * request with a DIFFERENT student's credential.
     */
    const refused = Effect.fn("JolliSession.refused")(function* (token: string) {
      const row = yield* active()
      if (!row) return yield* new JolliSignedOut({ message: "Not signed in to Jolli." })
      if (row.id === INJECTED_ROW_ID) {
        return yield* new JolliSignedOut({ message: `${JOLLI_TOKEN_ENV} was refused by Jolli.` })
      }
      // Somebody already renewed past the token that was refused — theirs is the answer, and
      // spending a second rotation on the same refusal would retire a credential in active use.
      if (row.access_token !== token) return row.access_token
      return yield* locked(row, (latest) => latest.access_token !== token)
    })

    return Service.of({
      current: Effect.fn("JolliSession.current")(() => active()),

      token,

      refused,

      request: Effect.fn("JolliSession.request")(function* () {
        const row = yield* active()
        // No tenant means no gateway to address; callers answer "unreachable" rather than guessing.
        if (!row?.base_url) return undefined
        /**
         * ⚠ `cache_key` RATHER THAN THE TOKEN IS WHAT FILES THE CATALOGUE SNAPSHOT. It is minted
         * once at sign-in and never touched by a refresh, so a rotating access token stops
         * orphaning the student's cache on every renewal while still keeping two students on one
         * machine apart. See `cache.ts`.
         */
        return gatewayRequest(row.base_url, { token: yield* token(), identity: row.cache_key })
      }),

      signIn: Effect.fn("JolliSession.signIn")(function* (credentials: JolliCredentials) {
        const now = yield* Clock.currentTimeMillis
        // Seconds on the wire, absolute milliseconds in the row — resolved against a clock the
        // tests can control, which is why `exchange.ts` deliberately does not do it.
        const expiry = expiryFor(credentials.expiresIn, credentials.refreshToken, now)
        return yield* store.persist({
          accessToken: credentials.token,
          ...(credentials.refreshToken ? { refreshToken: credentials.refreshToken } : {}),
          ...(expiry !== undefined ? { expiry } : {}),
          ...(credentials.subject ? { subject: credentials.subject } : {}),
          ...(credentials.email ? { email: credentials.email } : {}),
          ...(credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
        })
      }),

      signOut: Effect.fn("JolliSession.signOut")(function* () {
        // The injected credential is not ours to remove, and the stored one may still be there.
        const row = yield* store.active()
        if (!row) return
        yield* forget(row)
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [JolliStore.node] })
