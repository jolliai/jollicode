/**
 * THE MODELS JOLLI RUNS, DECLARED AS OPENCODE'S OWN CONFIG.
 *
 * ⚠ THE STUDENT DOES NOT CHOOSE A PROVIDER, EVER. They sign in to Jolli and Jolli decides what they
 * may run — that is the product. So rather than hiding provider screens one at a time, this removes
 * the subject: `enabled_providers` names only Jolli protocol providers, so every list the app builds — the
 * composer's picker, the model dialogs, the settings panes — is already empty of anything else
 * before a component reads it. A screen we forget to hide has nothing to show.
 *
 * ⚠ IT IS UPSTREAM'S MECHANISM, NOT A FORK OF ONE. `enabled_providers`, `provider.<id>.models` and
 * per-model routing are how opencode has always let a gateway declare its catalogue
 * (`packages/opencode/src/provider/provider.ts`).
 *
 * ⚠ BOTH SURFACES BUILD THEIR CONFIG HERE, BUT THEY DO NOT ENFORCE IT EQUALLY, AND THE DIFFERENCE
 * IS DELIBERATE. The desktop app serialises it into `JOLLICODE_CONFIG_CONTENT`, which is merged
 * near the top and outranks anything a student writes into a coursework repo — that surface is
 * genuinely locked. The bare CLI/TUI seeds it as the BOTTOM layer of
 * `packages/opencode/src/config/config.ts`, so it is a default rather than a ceiling: because
 * `mergeConfigConcatArrays` lets remeda's `mergeDeep` REPLACE arrays, a single `enabled_providers`
 * in a global or project `opencode.json` replaces it outright, and a `provider.jolli` block there
 * keeps whatever `options.baseURL` it declares. On the CLI this is a floor a config can step over,
 * and the tests in `test/config/jolli-lockdown.test.ts` pin it that way.
 *
 * ⚠ THE DESKTOP'S COPY NO LONGER DEPENDS ON WHO IS SIGNED IN. It declares the ceiling — one
 * provider, one gateway — and the server's own floor declares the models and resolves the
 * credential. That is what lets the Electron main process build this without ever holding a token.
 */
import { Brand } from "../brand"
import { isJolliOriginAllowed, parseJolliUrl } from "./origin"

/**
 * The wire protocols the Jolli gateway can dispatch to, in the order they appear in
 * `enabled_providers`. Kept as a hard-coded list because it is the lockdown surface:
 * one new value here is one new BYO channel a student can reach.
 *
 * `openai-compatible` is deliberately absent — it exists at the gateway level as a
 * relay flavour rather than as its own protocol, and nothing in the tenant catalogue
 * publishes models under it.
 */
export const SUPPORTED_PROTOCOLS = ["anthropic", "openai", "google"] as const
export type SupportedProtocol = (typeof SUPPORTED_PROTOCOLS)[number]

/**
 * The opencode provider id one wire protocol answers under.
 *
 * ⚠ EACH PROTOCOL GETS ITS OWN OPENCODE PROVIDER, AND THAT IS THE WHOLE REASON THIS EXISTS.
 * An opencode provider is one npm SDK plus one HTTP path shape, so the three protocols the
 * gateway serves cannot share a single provider id — the SDK's own routing decides which
 * URL a call reaches, and only one `npm` can be declared per provider block.
 */
export function providerIdFor(protocol: SupportedProtocol): string {
  return `${Brand.short}-${protocol}`
}

/** The opencode provider ids backed by the Jolli gateway. */
export const JOLLI_PROVIDER_IDS = SUPPORTED_PROTOCOLS.map(providerIdFor)

/** Whether an id names one of the protocol-specific Jolli providers. */
export function isJolliProviderId(id: string): boolean {
  return JOLLI_PROVIDER_IDS.includes(id)
}

/** Whether an id names either the folded auth row or a protocol-specific provider. */
export function isJolliAuthOrProviderId(id: string): boolean {
  return id === Brand.short || isJolliProviderId(id)
}

/** Whether the connected provider set contains any protocol-specific Jolli provider. */
export function isJolliConnected(connected: readonly string[]): boolean {
  return connected.some(isJolliProviderId)
}

/** Which `@ai-sdk/*` package owns the outbound HTTP for a given wire protocol. */
function npmForProtocol(protocol: SupportedProtocol): string {
  switch (protocol) {
    case "anthropic":
      return "@ai-sdk/anthropic"
    case "openai":
      return "@ai-sdk/openai"
    case "google":
      return "@ai-sdk/google"
  }
  return protocol satisfies never
}

/** One model the signed-in student is allowed to run. */
export interface JolliModel {
  /** The id the course and the UI name it by. */
  readonly id: string
  /** The human label shown in pickers. */
  readonly name: string
  /** The id actually sent upstream, when the gateway routes this one elsewhere. */
  readonly upstreamId?: string
}

export interface JolliConfigInput {
  /**
   * The signed-in user's tenant, e.g. `https://acme.jolli.ai`, as `cli-exchange` reported it.
   * Absent means signed out.
   */
  readonly baseUrl?: string
  /**
   * A gateway root to talk to instead of deriving one from the tenant.
   *
   * ⚠ NOT THE SAME THING AS `baseUrl`, WHICH IS WHY IT IS A SEPARATE FIELD. A tenant is the app and
   * the gateway hangs off its origin under `/api`; a gateway root already IS that endpoint, so
   * appending another `/api` produces a 404. Protocol version suffixes are still required by the
   * vendor SDKs. The desktop build pins one through
   * `JOLLICODE_GATEWAY_URL`; nothing else sets it.
   */
  readonly gatewayUrl?: string
  /** Whether a Jolli credential exists. Separate from `baseUrl`, which an older backend may omit. */
  readonly signedIn: boolean
  /**
   * The models this install may run, grouped by the wire protocol that answers them.
   *
   * ⚠ PASSED IN RATHER THAN KNOWN HERE, BECAUSE THE ANSWER IS THE SERVER'S. Which models a student
   * may run is a course's decision, and Jolli already records it — `CourseAssistant` carries
   * `allowedModelIds` and a resolved `models` catalogue.
   *
   * ⚠ GROUPED BY PROTOCOL SO THIS FILE CAN GENERATE ONE PROVIDER BLOCK PER `@ai-sdk/*` PACKAGE.
   * An opencode provider maps one-to-one to an SDK, and each SDK owns a specific HTTP shape, so
   * a model can only live inside the provider block whose npm serves its protocol.
   *
   * ⚠ ABSENT AND EMPTY ARE DIFFERENT ANSWERS, AND THE DESKTOP DEPENDS ON THE DIFFERENCE. An empty
   * record is "signed in, catalogue known, and it holds nothing": no provider blocks at all, which
   * is the state the sign-in gate keys off. Omitting the key entirely is "the catalogue is not
   * mine to declare" — every protocol still gets a block pinning `npm` and `baseURL`, with no
   * `models` key, so the server's own floor supplies the catalogue beneath the desktop's ceiling.
   */
  readonly models?: Readonly<Record<string, ReadonlyArray<JolliModel>>>
  /** Directory of generated course skills, when there are any. */
  readonly skillsDir?: string
}

/**
 * The Jolli base configuration, as a plain object.
 *
 * ⚠ THE PROVIDER BLOCK IS CONDITIONAL ON BEING SIGNED IN, AND THAT IS LOAD-BEARING RATHER THAN
 * TIDY. `jolli` is not in models.dev, so it can only enter the provider list by being declared
 * here — and a config-declared provider is resolved whether or not a credential exists
 * (`provider.ts` extends the catalogue from config unconditionally). The HTTP handler then reports
 * every resolved provider as connected, so declaring the block while signed out makes the whole app
 * believe the student is already signed in: the first-run login never triggers, `useConnected()` is
 * true so the composer is ungated, and the first message fails with no credential. Declaring only
 * `enabled_providers` while signed out leaves the provider list genuinely empty, which is what the
 * sign-in prompt keys off.
 */
export function jolliBaseConfig(input: JolliConfigInput) {
  return {
    /**
     * ⚠ THE WHOLE LOCKDOWN IS THIS LINE. Everything else here is a catalogue; this is what
     * makes the catalogue the only one. Removing it does not "show more models", it re-opens BYO
     * keys. Enumerated for all three supported protocols even when signed out so a logged-out
     * student still cannot reach a non-Jolli provider, and even when the catalog omits a
     * protocol (empty picker under that vendor) rather than opens BYO under its slot.
     */
    enabled_providers: JOLLI_PROVIDER_IDS,
    /**
     * ⚠ UPSTREAM'S SHARE PUBLISHES A SESSION TO OPENCODE'S OWN CLOUD, AND THIS TURNS IT OFF. A
     * student's session is shared on Jolli, with named course members, through the
     * `/jolli/session/:sessionID/share` routes; upstream's `session.share` uploads the whole
     * transcript to a public link on a third party's servers. The desktop no longer offers it, and
     * this is what makes the server refuse it for every other caller — the TUI's `/share`, a
     * plugin, a hand-written request — rather than trusting each of them to leave it alone.
     */
    share: "disabled" as const,
    /**
     * ⚠ IT IS THE V1 SHAPE — `{ paths: [...] }`, NOT A BARE ARRAY. Two config schemas live in this
     * repo: v1 takes `skills: { paths, urls }`, v2 takes a flat `skills: string[]`. A flat array
     * here validates against nothing, fails silently, and the skills simply never appear.
     * Omitted rather than empty when there is nothing to declare, because an empty path list is
     * still a list the server walks and logs about.
     */
    ...(input.skillsDir ? { skills: { paths: [input.skillsDir] } } : {}),
    ...(input.signedIn ? { provider: providerBlocks(input) } : {}),
  }
}

/**
 * One block per wire protocol that carries at least one model — or one per protocol full stop when
 * the caller declares no catalogue at all (see {@link JolliConfigInput.models}).
 *
 * ⚠ AN EMPTY BLOCK SET IS THE SIGNED-IN-BUT-NO-CATALOG POSTURE, AND IT MUST NOT COLLAPSE INTO THE
 * SIGNED-OUT ONE. `jolliBaseConfig` still emits `enabled_providers` in that case, so the resolver
 * finds three declared providers with no model rows — every list stays empty rather than the
 * BYO screens coming back.
 */
function providerBlocks(input: JolliConfigInput) {
  return Object.fromEntries(
    SUPPORTED_PROTOCOLS.filter((protocol) => !input.models || (input.models[protocol]?.length ?? 0) > 0).map(
      (protocol) => [providerIdFor(protocol), providerBlock(input, protocol, input.models?.[protocol])],
    ),
  )
}

function providerBlock(input: JolliConfigInput, protocol: SupportedProtocol, models?: ReadonlyArray<JolliModel>) {
  return {
    /**
     * ⚠ EVERY PROVIDER READS AS "JOLLI" ON THE SURFACE, EVEN THOUGH THERE ARE UP TO THREE OF THEM.
     * The vendor stays legible as the first word of every model's name; a student picks a MODEL,
     * not a vendor, so the provider label is intentionally uniform. The pass-through underneath
     * dispatches to the right upstream by protocol.
     */
    name: "Jolli",
    /**
     * ⚠ THE `npm` IS PROTOCOL-DEPENDENT AND NAMING IT IS NOT OPTIONAL. A config-declared provider
     * with no `npm` resolves to `@ai-sdk/openai-compatible`, which talks `/v1/chat/completions`.
     * Each protocol needs its matching SDK so the SDK-owned URL shape matches the pass-through
     * route the gateway serves. See `npmForProtocol` for the mapping and `PassThroughRouter` on
     * the backend for the route wiring.
     */
    npm: npmForProtocol(protocol),
    /**
     * ⚠ THE GATEWAY IS MOUNTED ON THE ORIGIN, NOT UNDER THE TENANT'S PATH. A path-based deployment
     * reports its tenant as `https://host/<slug>`, but the LLM routes live at `https://host/api`
     * and the tenant travels as a header — pointing the SDK at `https://host/<slug>/api` gets a 404
     * from the app router instead of the gateway. Same split `exchangeCliCode` makes, for the same
     * reason. A subdomain deployment has no slug and the header is simply absent.
     *
     * ⚠ THE `/v1` (OR `/v1beta`) SUFFIX ON THE BASE URL IS THE SDK'S CONVENTION AND IT IS NON-
     * OPTIONAL. Each vendor SDK appends only the last URL segment (`/messages`, `/responses`,
     * `/chat/completions`, `/models/{id}:{action}`) to whatever base URL it was given — it does
     * NOT add `/v1` for you (`@ai-sdk/anthropic` fetches `${baseURL}/messages`;
     * `@ai-sdk/openai` fetches `${baseURL}/responses`; `@ai-sdk/google` fetches
     * `${baseURL}/models/{...}`). Passing the bare `<origin>/api` leaves the SDK hitting
     * `<origin>/api/messages`, which the pass-through router has no route for → Express 404
     * "Not Found". The per-protocol suffix here is what makes the URL the SDK builds line up
     * with the routes `PassThroughRouter.ts` mounts (`/v1/messages`, `/v1/responses`,
     * `/v1/chat/completions`, `/v1beta/models/:modelAction`).
     *
     * ⚠ NO `apiKey` IS EVER WRITTEN HERE, ON EITHER SURFACE, AND THAT IS TRUE OF ALL THREE BLOCKS.
     * The credential lives in the shared database and reaches the model call through the provider's
     * own `fetch` — `plugin/jolli.ts` declares every Jolli provider id so the loader's options land
     * on each protocol block, and resolves the token per request. A token frozen into a config
     * object would be stale within one token lifetime and would also be a value a coursework repo
     * could overwrite. The desktop used to pass one because its sidecar had no `auth.json` entry to
     * read; it now reads the same database the CLI does.
     */
    options: gatewayOptions(input, protocol),
    /**
     * ⚠ OMITTED ENTIRELY WHEN ABSENT, RATHER THAN DECLARED EMPTY. The desktop hands this object to
     * the sidecar as the TOP config layer, and the merge keeps a key the top layer does not set —
     * so leaving `models` out is what lets the server's own floor supply the catalogue. Writing an
     * empty object here would replace nothing but would say the wrong thing about intent.
     */
    ...(models
      ? {
          models: Object.fromEntries(
            models.map((model) => [
              model.id,
              { name: model.name, ...(model.upstreamId ? { id: model.upstreamId } : {}) },
            ]),
          ),
        }
      : {}),
  }
}

/** SDK-expected URL segment appended to the gateway base URL, per protocol. */
function baseUrlSuffixFor(protocol: SupportedProtocol): string {
  switch (protocol) {
    case "anthropic":
      return "/v1"
    case "openai":
      return "/v1"
    case "google":
      return "/v1beta"
  }
  return protocol satisfies never
}

/**
 * ⚠ A GATEWAY ROOT KEEPS ITS OWN PATH AND ONLY A TENANT GETS `/api` APPENDED, WHICH IS THE WHOLE
 * DIFFERENCE BETWEEN THE TWO INPUTS. `Brand.gatewayUrl` is `https://api.jolli.ai` — the gateway on
 * its own host, already the `/api` mount — so appending again yields `https://api.jolli.ai/api`,
 * which nothing serves. A tenant is the app, and there the gateway does live under `/api` with the
 * slug in a header. A pinned `gatewayUrl` also keeps any path it carries before the protocol version
 * suffix is appended, which `parseJolliUrl` would otherwise drop.
 *
 * ⚠ A PINNED GATEWAY REPLACES THE TENANT RATHER THAN JOINING IT, SO THE TWO CANNOT BOTH BE
 * EXPRESSED. Nothing is derived from a gateway root — it is an endpoint, not a tenant — which means
 * the `x-tenant-slug` a path-based deployment (`https://host/<slug>`) would otherwise carry is
 * absent whenever one is pinned. Harmless for what pinning is for, a demo build aimed at a fixture
 * or a single-tenant host; a build aimed at a multi-tenant PATH deployment would reach the gateway
 * unidentified, and must leave `JOLLICODE_GATEWAY_URL` unset and let the signed-in tenant decide.
 */
function gatewayOptions(input: JolliConfigInput, protocol: SupportedProtocol) {
  const suffix = baseUrlSuffixFor(protocol)
  /**
   * ⚠ A BUILD-TIME PIN IS NOT ALLOWLISTED AND A STORED TENANT IS, WHICH IS THE ONE ASYMMETRY HERE.
   * `gatewayUrl` is compiled into the binary by whoever built it — a demo build aimed at a local
   * fixture is the whole point of it, and an allowlist would forbid exactly that. `baseUrl` arrives
   * from the credential store or the environment at runtime, which is a different kind of value.
   *
   * The per-protocol suffix (see `baseUrlSuffixFor`) is appended in every branch so each vendor
   * SDK's expected URL shape is met before it tacks on its own last segment.
   */
  if (input.gatewayUrl) return { baseURL: appendPathSuffix(input.gatewayUrl, suffix) }
  /**
   * ⚠ THE SAME ALLOWLIST THE CATALOGUE FETCH APPLIES, FOR A SHARPER REASON. `gatewayRequest` in
   * `api.ts` re-checks a stored tenant before sending the student's token to it, and this value is
   * held to that too: it becomes the LLM provider's `baseURL`, and the provider's `fetch` attaches
   * the student's credential to whatever that URL turns out to be. Refusing an origin for the
   * catalogue while handing it the same credential on every model call would be the wrong half to
   * guard. Falling back to the default gateway keeps a garbled value from reaching the SDK at all.
   */
  if (!input.baseUrl || !isJolliOriginAllowed(input.baseUrl)) {
    return { baseURL: appendPathSuffix(Brand.gatewayUrl, suffix) }
  }
  const tenant = parseJolliUrl(input.baseUrl)
  return {
    baseURL: appendPathSuffix(`${tenant.origin}/api`, suffix),
    ...(tenant.tenantSlug ? { headers: { "x-tenant-slug": tenant.tenantSlug } } : {}),
  }
}

function appendPathSuffix(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`
}
