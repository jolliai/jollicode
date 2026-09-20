/**
 * THE MODELS JOLLI RUNS, DECLARED AS OPENCODE'S OWN CONFIG.
 *
 * ⚠ THE STUDENT DOES NOT CHOOSE A PROVIDER, EVER. They sign in to Jolli and Jolli decides what they
 * may run — that is the product. So rather than hiding provider screens one at a time, this removes
 * the subject: `enabled_providers` names exactly one provider, so every list the app builds — the
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
 * keeps whatever `options.apiKey` and `options.baseURL` it declares. On the CLI this is a floor a
 * config can step over, and the tests in `test/config/jolli-lockdown.test.ts` pin it that way.
 */
import { Brand } from "../brand"
import { parseJolliUrl } from "./origin"

/** The provider id, the XDG directory segment and the auth.json key are all this one slug. */
const PROVIDER_ID = Brand.short

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
   * A gateway root to talk to instead of deriving one from the tenant, used verbatim.
   *
   * ⚠ NOT THE SAME THING AS `baseUrl`, WHICH IS WHY IT IS A SEPARATE FIELD. A tenant is the app and
   * the gateway hangs off its origin under `/api`; a gateway root already IS that endpoint, so
   * appending anything to it produces a 404. The desktop build pins one through
   * `JOLLICODE_GATEWAY_URL`; nothing else sets it.
   */
  readonly gatewayUrl?: string
  /** Whether a Jolli credential exists. Separate from `baseUrl`, which an older backend may omit. */
  readonly signedIn: boolean
  /**
   * The signed-in student's CLI JWT, for a surface that has no `auth.json` entry to read it back
   * from.
   *
   * ⚠ IT IS A JWT AND NOT AN API KEY, WHICH IS WHY IT IS NOT CALLED ONE HERE. It does leave as
   * `options.apiKey`, because that is the field opencode's provider schema fills a bearer
   * credential from and the Jolli gateway normalises the resulting `x-api-key` into
   * `Authorization: Bearer` — `plugin/jolli.ts` makes the same note about `auth.json`. Nothing about
   * it resembles the build-time `"public"` key this replaced, which authenticated as nobody.
   *
   * ⚠ ONLY THE DESKTOP APP PASSES IT, AND ONLY BECAUSE ITS SIGN-IN DOES NOT GO THROUGH THE PROVIDER
   * PLUGIN. The bare CLI signs in through `plugin/jolli.ts`, which stores the token in `auth.json`
   * under this provider id, and the provider resolver fills the key in from there. The desktop
   * signs in from the Electron main process and keeps the token encrypted in the OS keychain
   * instead, so the sidecar would otherwise resolve a provider with no credential and fail on the
   * first message while still reporting as connected. It travels inside `JOLLICODE_CONFIG_CONTENT`,
   * which is an environment variable rather than a file on disk.
   */
  readonly authToken?: string
  /**
   * The models this install may run.
   *
   * ⚠ PASSED IN RATHER THAN KNOWN HERE, BECAUSE THE ANSWER IS THE SERVER'S. Which models a student
   * may run is a course's decision, and Jolli already records it — `CourseAssistant` carries
   * `allowedModelIds` and a resolved `models` catalogue. Today both callers hand over the interim
   * mock list from `model-catalog.ts`; when the grant is fetched at sign-in, only the callers
   * change and this file does not.
   */
  readonly models: ReadonlyArray<JolliModel>
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
     * ⚠ THE WHOLE LOCKDOWN IS THIS ONE LINE. Everything else here is a catalogue; this is what
     * makes the catalogue the only one. Removing it does not "show more models", it re-opens BYO
     * keys. It is declared signed out too, so a logged-out student still cannot reach one.
     */
    enabled_providers: [PROVIDER_ID],
    /**
     * ⚠ IT IS THE V1 SHAPE — `{ paths: [...] }`, NOT A BARE ARRAY. Two config schemas live in this
     * repo: v1 takes `skills: { paths, urls }`, v2 takes a flat `skills: string[]`. A flat array
     * here validates against nothing, fails silently, and the skills simply never appear.
     * Omitted rather than empty when there is nothing to declare, because an empty path list is
     * still a list the server walks and logs about.
     */
    ...(input.skillsDir ? { skills: { paths: [input.skillsDir] } } : {}),
    ...(input.signedIn ? { provider: { [PROVIDER_ID]: providerBlock(input) } } : {}),
  }
}

function providerBlock(input: JolliConfigInput) {
  return {
    /**
     * ⚠ ONE PROVIDER, WHERE THE WEB MOCK GROUPS BY VENDOR. On this surface Jolli IS the provider —
     * it is who the student signed in to and who answers. The vendor stays legible as the first
     * word of every model's name.
     */
    name: "Jolli",
    /**
     * ⚠ THE PROTOCOL IS ANTHROPIC, AND NAMING IT IS NOT OPTIONAL. A config-declared provider with
     * no `npm` resolves to `@ai-sdk/openai-compatible`, which talks `/v1/chat/completions` — and
     * the Jolli gateway serves only the Anthropic pair, refusing the other two protocols at the
     * door. Leaving this out produces a provider that lists perfectly and fails on every send.
     */
    npm: "@ai-sdk/anthropic",
    /**
     * ⚠ THE GATEWAY IS MOUNTED ON THE ORIGIN, NOT UNDER THE TENANT'S PATH. A path-based deployment
     * reports its tenant as `https://host/<slug>`, but the LLM routes live at `https://host/api`
     * and the tenant travels as a header — pointing the SDK at `https://host/<slug>/api` gets a 404
     * from the app router instead of the gateway. Same split `exchangeCliCode` makes, for the same
     * reason. A subdomain deployment has no slug and the header is simply absent.
     *
     * ⚠ `apiKey` IS ABSENT UNLESS THE CALLER HAD NOWHERE ELSE TO PUT THE CREDENTIAL, AND WHEN IT IS
     * THERE IT HOLDS A JWT RATHER THAN A KEY. On the bare CLI the JWT is in `auth.json` under this
     * provider id and the resolver fills it in on its own, so nothing should write it here;
     * `JolliConfigInput.authToken` says why the desktop is different and why the field is named as it is.
     */
    options: {
      ...gatewayOptions(input),
      ...(input.authToken ? { apiKey: input.authToken } : {}),
    },
    models: Object.fromEntries(
      input.models.map((model) => [
        model.id,
        { name: model.name, ...(model.upstreamId ? { id: model.upstreamId } : {}) },
      ]),
    ),
  }
}

/**
 * ⚠ A GATEWAY ROOT IS USED VERBATIM AND ONLY A TENANT GETS `/api` APPENDED, WHICH IS THE WHOLE
 * DIFFERENCE BETWEEN THE TWO INPUTS. `Brand.gatewayUrl` is `https://api.jolli.ai` — the gateway on
 * its own host, already the `/api` mount — so appending again yields `https://api.jolli.ai/api`,
 * which nothing serves. A tenant is the app, and there the gateway does live under `/api` with the
 * slug in a header. A pinned `gatewayUrl` also keeps any path it carries, which `parseJolliUrl`
 * would otherwise drop.
 */
function gatewayOptions(input: JolliConfigInput) {
  if (input.gatewayUrl) return { baseURL: input.gatewayUrl }
  // A stored tenant is only as good as whatever wrote it: garbage must fail here, not reach the SDK.
  if (!input.baseUrl || !URL.canParse(input.baseUrl)) return { baseURL: Brand.gatewayUrl }
  const tenant = parseJolliUrl(input.baseUrl)
  return {
    baseURL: `${tenant.origin}/api`,
    ...(tenant.tenantSlug ? { headers: { "x-tenant-slug": tenant.tenantSlug } } : {}),
  }
}
