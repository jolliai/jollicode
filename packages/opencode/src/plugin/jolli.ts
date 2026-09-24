/**
 * SIGNING IN TO JOLLI, AS A PROVIDER AUTH METHOD.
 *
 * ⚠ THE FLOW ITSELF LIVES IN CORE. `startJolliLogin` is shared with the desktop app so the two
 * surfaces cannot drift on the wire contract; everything specific to this one is here.
 *
 * ⚠ THIS PLUGIN DOES NOT OPEN THE BROWSER, DELIBERATELY. `authorize` runs inside the opencode
 * server, which is not always the machine the user is sitting at — opening a browser there is how a
 * remote `opencode serve` ends up launching Chrome on a server nobody can see. It returns the URL
 * and the client decides; the TUI opens it on mount, and the desktop's main process does the same.
 *
 * ⚠ THE CREDENTIAL DOES NOT GO INTO `auth.json`, WHICH IS WHY TWO THINGS HERE LOOK UNUSUAL. It goes
 * into the database both surfaces share, so `callback` persists it itself and reports a `managed`
 * success, and `loadWithoutCredential` is what lets the loader run at all — `provider.ts` otherwise
 * skips a loader whose provider has no `auth.json` entry. The `auth()` argument the loader is handed
 * is therefore always undefined for Jolli, and is not used.
 *
 * ⚠ ONE SIGN-IN, THREE PROVIDERS. The gateway dispatches to three wire protocols and each one needs
 * its own opencode provider (one npm SDK, one URL shape), but the sign-in is a single act recorded
 * under the bare `jolli` id. `providers` is what carries the resolved `fetch` to all three; without
 * it the protocol providers resolve with no credential and 401 on the first message.
 */
import { Brand } from "@opencode-ai/core/brand"
import { Flag } from "@opencode-ai/core/flag/flag"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { JOLLI_PROVIDER_IDS } from "@opencode-ai/core/jolli/gateway-config"
import { startJolliLogin } from "@opencode-ai/core/jolli/loopback"
import { isJolliOriginAllowed } from "@opencode-ai/core/jolli/origin"
import { JolliSession } from "@opencode-ai/core/jolli/session"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Effect } from "effect"
import { OAUTH_DUMMY_KEY } from "@/auth"
import type { EffectBridge } from "@/effect/bridge"

export async function JolliAuthPlugin(_input: PluginInput, options: { bridge: EffectBridge.Shape }): Promise<Hooks> {
  const use = <A, E>(fn: (service: JolliSession.Interface) => Effect.Effect<A, E>) =>
    options.bridge.promise(JolliSession.Service.use(fn))

  return {
    auth: {
      provider: Brand.short,
      providers: JOLLI_PROVIDER_IDS,
      loadWithoutCredential: true,
      /**
       * ⚠ THE `apiKey` IS A PLACEHOLDER AND THE `fetch` IS THE REAL CREDENTIAL PATH. Provider
       * options are resolved once and cached for the life of the process, so a token written here
       * would be stale within one token lifetime; `provider.ts` calls this `fetch` on every
       * outbound request instead. `azure.ts` and `github-copilot` do the same, for the same reason.
       *
       * ⚠ AND IT MUST BE NON-EMPTY. Some SDKs refuse to build a request with a blank key before any
       * of this runs — `azure.ts` uses the same dummy rather than `""`.
       */
      async loader() {
        // The non-refreshing read: this runs during provider resolution and must not touch the
        // network. Signed out means no provider options at all, not a `fetch` that cannot work.
        const credential = await use((service) => service.current())
        if (!credential) return {}

        /**
         * ⚠ THE ONE ADDRESS OUTSIDE THE ALLOWLIST THAT THE CREDENTIAL STILL BELONGS AT. A build may
         * pin its gateway (`gateway-config.ts`), and pinning exists for the addresses the allowlist
         * cannot name — a demo build aimed at a fixture is the stated use. That exemption held for
         * the config's `baseURL` and not here, so such a build sent every model call to the right
         * place with no credential on it and 401ed on the first message — and returned below before
         * the 401 handling, so nothing even noticed. Read once: it is a build constant, and
         * `Flag.JOLLICODE_GATEWAY_URL` answers nothing unless the surface is the locked one.
         *
         * ⚠ MATCHED AS A PREFIX, NOT AS AN ORIGIN, because a pin keeps its own path. The SDK appends
         * the protocol suffix and its own last segment to exactly this value, so anything the
         * provider legitimately calls starts with it — and nothing else on that host does.
         */
        const pinnedGateway = Flag.JOLLICODE_GATEWAY_URL?.replace(/\/+$/, "")

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            const headers = new Headers(input instanceof Request ? input.headers : undefined)
            new Headers(init?.headers).forEach((value, key) => headers.set(key, value))

            const url = input instanceof Request ? input.url : input.toString()
            /**
             * ⚠ THE DESTINATION IS CHECKED BEFORE THE CREDENTIAL IS ATTACHED, exactly as
             * `gatewayRequest` does for catalogue calls and for the same stated reason — this
             * request carries the student's credential. A config layer can set `options.baseURL`, so
             * without this a repository could choose where the token gets sent. Unauthenticated is
             * the correct failure; silently obliging is not.
             */
            if (!isJolliOriginAllowed(url) && !(pinnedGateway && url.startsWith(`${pinnedGateway}/`))) {
              // Do not send SDK or config credentials to a destination outside the Jolli gateway.
              headers.delete("x-api-key")
              headers.delete("x-goog-api-key")
              headers.delete("authorization")
              return fetch(input, { ...init, headers })
            }

            const token = await use((service) => service.token())
            // The gateway authenticates with Bearer; vendor SDK headers stay intact for forwarding.
            headers.set("authorization", `Bearer ${token}`)
            /**
             * ⚠ CLONED BEFORE THE FIRST SEND, BECAUSE A SENT `Request` HAS NO BODY LEFT. The SDKs
             * hand us a `Request` on some paths and a URL plus `init` on others; only the first
             * needs this, and it has to happen before the body is consumed rather than in the
             * retry below, where there would be nothing left to copy.
             *
             * A streamed body cannot be sent twice at all, so there is nothing to retry with — the
             * renewal below still runs, because that is what ends a finished credential.
             */
            const retryable =
              input instanceof Request ? input.clone() : init?.body instanceof ReadableStream ? undefined : input
            const answer = await fetch(input, { ...init, headers })
            if (answer.status !== 401) return answer

            /**
             * ⚠ THE ONLY PLACE A MODEL CALL'S 401 REACHES THE REFRESH PATH — see
             * `JolliSession.refused`. A revoked token is refused long before it expires, and expiry
             * is what normally triggers a renewal, so without this a password change leaves every
             * message failing for the rest of the token's life while the app still believes it is
             * signed in. `/jolli/course` reaches the same place from the other side, for the
             * student who opens the app and never sends anything.
             *
             * One retry, and only when the token actually changed: `refused` answers with the one
             * we sent when the backend could not be reached, and re-sending that would be a second
             * identical failure. A refusal that outlives the renewal — the credential is finished —
             * arrives as `Jolli.SignedOut` AFTER the row has already been deleted, which is what
             * turns the next screen into "sign in again" rather than another silent failure.
             */
            const renewed = await use((service) => service.refused(token)).catch(() => undefined)
            if (!renewed || renewed === token || !retryable) return answer
            // Nothing will read the refusal now that it is being replaced, and an abandoned body
            // holds its connection open.
            await answer.body?.cancel()
            headers.set("authorization", `Bearer ${renewed}`)
            return fetch(retryable, { ...init, headers })
          },
        }
      },
      methods: [
        {
          type: "oauth",
          label: `Sign in to ${Brand.platform}`,
          async authorize() {
            const attempt = await startJolliLogin({ clientVersion: InstallationVersion })
            return {
              url: attempt.url,
              instructions: "Complete sign-in in your browser. This window will close automatically.",
              method: "auto" as const,
              async callback() {
                const credentials = await attempt.wait().catch(() => undefined)
                if (!credentials) return { type: "failed" as const }
                await use((service) => service.signIn(credentials))
                // Already stored, so there is nothing for `ProviderAuth` to write to `auth.json`.
                return { type: "success" as const, provider: Brand.short, managed: true as const }
              },
            }
          },
        },
      ],
    },
  }
}
