/**
 * THE JOLLI CONFIG THE SIDECAR SERVER IS STARTED WITH.
 *
 * ⚠ THE SHAPE ITSELF LIVES IN `@opencode-ai/core/jolli/gateway-config`, SHARED WITH THE BARE CLI.
 * Both surfaces must lock to the same provider and point at the same gateway, and an earlier
 * version of this file was the only place that knew how — so the CLI had none of it. What stays
 * here is what is genuinely desktop-only: the generated course skills under `userData`.
 *
 * ⚠ IT ARRIVES AS `JOLLICODE_CONFIG_CONTENT`, WHICH IS THE STRONGEST LAYER SHORT OF MDM. Config
 * merges well-known → global → custom → project → this (`config/config.ts`), so a student who
 * writes an `opencode.json` into their coursework repository cannot widen the list.
 */
import { rmSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { gatewayRequest } from "@opencode-ai/core/jolli/api"
import { loadCatalog, STARTUP_DEADLINE } from "@opencode-ai/core/jolli/cache"
import { toProviderModels } from "@opencode-ai/core/jolli/catalog"
import { jolliBaseConfig } from "@opencode-ai/core/jolli/gateway-config"

/**
 * WHICH REAL ENDPOINT ANSWERS. A build may pin one via `JOLLICODE_GATEWAY_URL` (electron.vite
 * define); otherwise the tenant the student signed in to decides, and `jolliBaseConfig` falls back
 * to `Brand.gatewayUrl`. It is deliberately NOT a runtime env var: the gateway is the model
 * lockdown, and a runtime var would be inherited from the student's shell (`preferAppEnv`) and let
 * them repoint it — see the scrub in `server.ts`.
 *
 * ⚠ THERE IS NO LONGER A BUILD-TIME KEY. Requests authenticate as the signed-in student, with the
 * credential sign-in stored; the old static `"public"` key authenticated as nobody in particular.
 *
 * ⚠ IT IS A GATEWAY ROOT, NOT A TENANT, AND `jolliBaseConfig` KEEPS THOSE APART. It is handed over
 * as `gatewayUrl` so it reaches the SDK verbatim; passing it as `baseUrl` would have `/api` appended
 * to an endpoint that is already the gateway, and would drop any path it carries.
 */
const GATEWAY_URL = import.meta.env.JOLLICODE_GATEWAY_URL || undefined

/**
 * The config the sidecar server is started with, as JSON.
 *
 * ⚠ THE TOKEN IS PART OF IT, WHICH IS NOT TRUE OF THE BARE CLI. The sidecar has no `auth.json`
 * entry for this provider — the student signed in through the Electron main process, not through
 * the provider plugin — so the credential has to arrive with the config or every model call goes
 * out unauthenticated while the app still reports as connected. `JolliConfigInput.authToken` spells the
 * split out; `server.ts` keeps this string in the sidecar's environment rather than on disk.
 */
export async function jolliGatewayConfig(input: {
  signedIn: boolean
  authToken?: string
  baseUrl?: string
  skillsDir?: string
}): Promise<string> {
  return JSON.stringify(
    jolliBaseConfig({
      signedIn: input.signedIn,
      models: await tenantModels(input),
      // A build-pinned gateway wins over the tenant, so a demo build can be aimed at a fixture.
      ...(GATEWAY_URL ? { gatewayUrl: GATEWAY_URL } : {}),
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      ...(input.authToken ? { authToken: input.authToken } : {}),
      ...(input.skillsDir ? { skillsDir: input.skillsDir } : {}),
    }),
  )
}

/**
 * EVERY MODEL THE SIGNED-IN TENANT OFFERS — the whole catalogue, not the courses' union.
 *
 * ⚠ THE COURSE GRANT NARROWS THIS IN THE RENDERER, NOT HERE. Declaring only what some course
 * currently grants would mean a professor adding a model could not take effect until the app was
 * restarted, since this config is frozen when the sidecar forks. The catalogue is the candidate
 * pool; `ModelGrant` decides what a student may see, and the gateway is what refuses a model a
 * course did not grant.
 *
 * ⚠ AND IT FALLS BACK TO NOTHING RATHER THAN TO A LOCAL LIST. The old fallback named models by name
 * (`claude-opus-4-8`) while a course grants them by Registry UUID, so mixing the two produced a
 * provider whose every model failed the grant — an empty picker with no error to explain it. An
 * empty `models` block is the same emptiness, honestly arrived at, and the sign-in gate is already
 * saying why.
 */
async function tenantModels(input: { signedIn: boolean; authToken?: string; baseUrl?: string }) {
  if (!input.signedIn || !input.authToken || !input.baseUrl) return []
  const request = gatewayRequest(input.baseUrl, input.authToken)
  if (!request) return []
  /**
   * ⚠ IT CANNOT BE ALLOWED TO REJECT. This runs inside `createSidecarEnv()`, so anything thrown
   * here stops the sidecar forking and the app has no server at all — a catalogue that could not
   * be fetched is worth an empty model list, never that.
   *
   * ⚠ NOR TO TAKE ITS TIME, WHICH IS THE HALF THAT IS EASY TO MISS. Not rejecting is no comfort to
   * a student watching a splash screen: the sidecar does not fork until this returns, so every
   * second here is a second the app has no server. `STARTUP_DEADLINE` is what bounds it, and
   * running out lands on the stale snapshot rather than on an error.
   */
  const loaded = await Effect.runPromise(loadCatalog(request, { timeout: STARTUP_DEADLINE })).catch(() => undefined)
  if (!loaded || loaded.kind !== "ok") return []
  return toProviderModels(new Map(loaded.snapshot.models.map((model) => [model.id, model])))
}

/**
 * CLEAR THE GENERATED COURSE SKILLS. There are none to write yet.
 *
 * ⚠ THIS USED TO MATERIALISE `ASSISTANTS[*].skills` FROM THE FIXTURES, AND THAT SOURCE IS GONE.
 * Courses and assistants now come from the Jolli gateway, whose student-facing assistant shape
 * (`assistant-choices`) carries no skills at all — jolliedu has no such concept. Writing the
 * fixtures' skills against real courses would have offered every student a procedure no professor
 * of theirs had written.
 *
 * ⚠ IT STILL CLEARS, AND THAT IS THE POINT OF KEEPING IT. Anyone upgrading from a build that DID
 * write these has stale `SKILL.md` files under `userData` that the server would keep discovering
 * and offering as slash commands. Returning `undefined` stops the config pointing at the directory;
 * removing it stops the files existing.
 *
 * When the gateway serves skills, this is where they land again.
 */
export function clearCourseSkills(userDataPath: string) {
  rmSync(join(userDataPath, "jolli-skills"), { recursive: true, force: true })
}
