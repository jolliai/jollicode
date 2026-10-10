import { ProviderAuth } from "@/provider/auth"
import { Config } from "@/config/config"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Brand } from "@opencode-ai/core/brand"
import { isJolliAuthOrProviderId, JOLLI_PROVIDER_IDS } from "@opencode-ai/core/jolli/gateway-config"
import { Provider } from "@/provider/provider"
import { Auth } from "@/auth"
import { JolliSession } from "@opencode-ai/core/jolli/session"

import { mapValues } from "remeda"
import { Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ProviderAuthApiError } from "../groups/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"

function mapProviderAuthError<A, R>(self: Effect.Effect<A, ProviderAuth.Error, R>) {
  return self.pipe(
    Effect.mapError((error) => {
      if (error instanceof ProviderAuth.OauthMissing) {
        return new ProviderAuthApiError({ name: error._tag, data: { providerID: error.providerID } })
      }
      if (error instanceof ProviderAuth.OauthCodeMissing) {
        return new ProviderAuthApiError({ name: error._tag, data: { providerID: error.providerID } })
      }
      if (error instanceof ProviderAuth.OauthCallbackFailed) {
        return new ProviderAuthApiError({ name: error._tag, data: {} })
      }
      if (error instanceof ProviderAuth.ValidationFailed) {
        return new ProviderAuthApiError({ name: error._tag, data: { field: error.field, message: error.message } })
      }
      return new ProviderAuthApiError({ name: "BadRequest", data: {} })
    }),
  )
}

/**
 * WHICH PROVIDERS A CREDENTIAL IS ACTUALLY HELD FOR, RIGHT NOW.
 *
 * ⚠ THE TWO INPUTS ANSWER DIFFERENT QUESTIONS, AND THAT IS THE WHOLE REASON THIS IS A FUNCTION.
 * `resolved` is instance state — worked out once, from a config built while the student was signed
 * in — and it keeps naming the Jolli providers long after the credential behind them is gone. Two
 * things remove one while the app runs: another surface signing out of the shared store, and the
 * backend refusing a renewal. Neither rebuilds this instance, so a stale resolution left voting
 * here makes the whole app believe a credential exists; the composer goes on offering models and
 * the refusal arrives as a gateway 401 the student cannot act on.
 *
 * ⚠ ONLY THE JOLLI IDS ARE SUBJECT TO IT. Every other provider resolves from a key in `auth.json`
 * or the environment, which is read on the same pass — no separate store can go out from under it.
 *
 * ⚠ AND `stored` STILL CARRIES THE OPPOSITE CASE. A student whose catalogue could not be fetched
 * resolves no Jolli provider at all and is reported through that half instead, which is why the
 * union exists in the first place.
 */
export function connectedProviderIds(input: {
  resolved: ReadonlyArray<string>
  stored: ReadonlyArray<string>
  jolliCredential: boolean
}) {
  const live = input.resolved.filter((id) => input.jolliCredential || !isJolliAuthOrProviderId(id))
  return Array.from(new Set([...live, ...input.stored]))
}

export const providerHandlers = HttpApiBuilder.group(InstanceHttpApi, "provider", (handlers) =>
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const provider = yield* Provider.Service
    const svc = yield* ProviderAuth.Service
    const authStore = yield* Auth.Service
    const jolliSvc = yield* JolliSession.Service

    const list = Effect.fn("ProviderHttpApi.list")(function* () {
      const config = yield* cfg.get()
      const all = yield* ModelsDev.Service.use((s) => s.get())
      const disabled = new Set(config.disabled_providers ?? [])
      const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined
      const allowed = (id: string) => (enabled ? enabled.has(id) : true) && !disabled.has(id)
      const filtered: Record<string, (typeof all)[string]> = {}
      for (const [key, value] of Object.entries(all)) {
        if (allowed(key)) filtered[key] = value
      }
      const connected = yield* provider.list()
      const credentials = yield* authStore.all().pipe(Effect.orDie)
      /** ⚠ THE NON-REFRESHING READ. This endpoint is polled, and a signed-in check has no business
       * reaching the network. */
      const jolliCredential = yield* jolliSvc.current()
      const credentialConnections = [
        /**
         * ⚠ `auth.json` DOES NOT GET A VOTE ON JOLLI, AND AN UPGRADING INSTALL IS WHY. Every install
         * that signed in before the credential moved to the database still has a `jolli` entry
         * sitting in that file, and nothing reads it any more — so counting it here reports a
         * student as connected who has no usable credential at all: the sign-in dialog never offers
         * to fix it and every message fails. The database is the only store, so it is the only
         * answer, and the line below it is the one that gives it.
         */
        ...Object.keys(credentials).filter((id) => id !== Brand.short && allowed(id)),
        /**
         * ⚠ ONE STORED CREDENTIAL ANSWERS FOR EVERY PROTOCOL PROVIDER, because that is what the
         * config declares and what `plugin/jolli.ts` resolves options for. The bare `jolli` id is
         * the auth surface, not a provider anything runs against, so it is not reported here.
         */
        ...(jolliCredential ? JOLLI_PROVIDER_IDS.filter(allowed) : []),
      ]
      const providers = Object.assign(
        mapValues(filtered, (item) => Provider.fromModelsDevProvider(item)),
        connected,
      )
      return {
        all: Object.values(providers).map(Provider.toPublicInfo),
        default: Provider.defaultModelIDs(providers),
        /**
         * ⚠ A HELD CREDENTIAL COUNTS EVEN WHEN NO PROVIDER BLOCK SURVIVED TO CARRY IT. A provider
         * that resolves to zero models is deleted outright (`provider/provider.ts`), and that is
         * exactly what a Jolli sign-in looks like whenever the course catalogue cannot be fetched —
         * `cli-exchange` on an older backend reports no tenant, and there is no origin to guess. Read
         * off the surviving blocks alone, this then answers "signed out" to a student who has just
         * signed in; `dialog-provider.tsx` believes it and sends them back out to a browser sign-in
         * that stores the same credential again, on every launch. Holding the credential is the
         * honest answer to the question this field asks.
         */
        connected: connectedProviderIds({
          resolved: Object.keys(connected),
          stored: credentialConnections,
          jolliCredential: !!jolliCredential,
        }),
      }
    })

    const auth = Effect.fn("ProviderHttpApi.auth")(function* () {
      return yield* svc.methods()
    })

    const authorize = Effect.fn("ProviderHttpApi.authorize")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: ProviderAuth.AuthorizeInput
    }) {
      return yield* mapProviderAuthError(
        svc.authorize({
          providerID: ctx.params.providerID,
          method: ctx.payload.method,
          inputs: ctx.payload.inputs,
        }),
      )
    })

    const authorizeRaw = Effect.fn("ProviderHttpApi.authorizeRaw")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const payload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ProviderAuth.AuthorizeInput))(body).pipe(
        Effect.mapError(() => new ProviderAuthApiError({ name: "BadRequest", data: {} })),
      )
      // Match legacy route behavior: when authorize() resolves without a
      // result (e.g. no further redirect), serialize as JSON `null` instead
      // of an empty body so clients can `.json()` parse the response.
      const result = yield* authorize({ params: ctx.params, payload })
      return HttpServerResponse.jsonUnsafe(result ?? null)
    })

    const callback = Effect.fn("ProviderHttpApi.callback")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: ProviderAuth.CallbackInput
    }) {
      yield* mapProviderAuthError(
        svc.callback({
          providerID: ctx.params.providerID,
          method: ctx.payload.method,
          code: ctx.payload.code,
        }),
      )
      return true
    })

    return handlers
      .handle("list", list)
      .handle("auth", auth)
      .handleRaw("authorize", authorizeRaw)
      .handle("callback", callback)
  }),
)
