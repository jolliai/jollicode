/**
 * THE JOLLI CONFIG THE SIDECAR SERVER IS STARTED WITH.
 *
 * ⚠ THE SHAPE ITSELF LIVES IN `@opencode-ai/core/jolli/gateway-config`, SHARED WITH THE BARE CLI.
 * Both surfaces must lock to the same provider and point at the same gateway, and an earlier
 * version of this file was the only place that knew how — so the CLI had none of it. What stays
 * here is what is genuinely desktop-only: the course skills written to `userData`, and `ROUTE`.
 *
 * ⚠ IT ARRIVES AS `JOLLICODE_CONFIG_CONTENT`, WHICH IS THE STRONGEST LAYER SHORT OF MDM. Config
 * merges well-known → global → custom → project → this (`config/config.ts`), so a student who
 * writes an `opencode.json` into their coursework repository cannot widen the list.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ASSISTANTS } from "@opencode-ai/app/jolli/fixtures"
import { jolliBaseConfig } from "@opencode-ai/core/jolli/gateway-config"
import { catalogModels, type ModelTier } from "@opencode-ai/core/jolli/model-catalog"

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
 * ⚠ EVERY JOLLI MODEL IS ROUTED TO A MODEL THAT ACTUALLY ANSWERS, AND THAT IS THE ONE PLACE THIS
 * MOCK IS PRETENDING. The catalogue is the web mock's, and most of those models do not exist yet
 * (`data/models.ts` says so itself: "the models a course would be choosing between a version or two
 * from now"). Declared without a route, they would list beautifully and fail on send, which is the
 * worst outcome in front of a customer — the demo dies on the first message.
 *
 * ⚠ AND ROUTING IS WHAT A GATEWAY DOES, so this is the honest shape rather than a hack: a course
 * names a model, the gateway decides what serves it. `model.id` is the id sent upstream while the
 * map key stays the id the course config and the UI use.
 *
 * ⚠ SAY THIS OUT LOUD BEFORE ANYBODY JUDGES AN ANSWER'S QUALITY. A reply labelled "Claude Opus 5"
 * came from a free model on OpenCode Zen. Demo the CONTROLS with this; do not demo the ANSWERS.
 *
 * ⚠ FOLLOW-UP (deliberately not done here): the static gateway key is gone and requests now
 * authenticate as the signed-in student, but `ROUTE` still rewrites every send to a free model.
 * Deleting it — and sending the catalogue id straight through — is the remaining step, and it lands
 * naturally with the course-granted catalogue that replaces `catalogModels`.
 */
const ROUTE: Record<ModelTier, string> = {
  premium: "big-pickle",
  standard: "nemotron-3.5-lightning-free",
  economy: "ling-3.0-flash-fin-free",
}

/**
 * The config the sidecar server is started with, as JSON.
 *
 * ⚠ THE TOKEN IS PART OF IT, WHICH IS NOT TRUE OF THE BARE CLI. The sidecar has no `auth.json`
 * entry for this provider — the student signed in through the Electron main process, not through
 * the provider plugin — so the credential has to arrive with the config or every model call goes
 * out unauthenticated while the app still reports as connected. `JolliConfigInput.authToken` spells the
 * split out; `server.ts` keeps this string in the sidecar's environment rather than on disk.
 */
export function jolliGatewayConfig(input: {
  signedIn: boolean
  authToken?: string
  baseUrl?: string
  skillsDir?: string
}): string {
  return JSON.stringify(
    jolliBaseConfig({
      signedIn: input.signedIn,
      // Interim: the grant is the course's and should arrive with sign-in. See `catalogModels`.
      models: catalogModels(ROUTE),
      // A build-pinned gateway wins over the tenant, so a demo build can be aimed at a fixture.
      ...(GATEWAY_URL ? { gatewayUrl: GATEWAY_URL } : {}),
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      ...(input.authToken ? { authToken: input.authToken } : {}),
      ...(input.skillsDir ? { skillsDir: input.skillsDir } : {}),
    }),
  )
}


/**
 * MATERIALISE THE COURSES' SKILLS AS FILES THE SERVER CAN DISCOVER, AND RETURN THE DIRECTORY.
 *
 * ⚠ ONE FILE PER SKILL, NAMED BY ITS `skillId`, WITH THE NAME IN FRONTMATTER. opencode takes a
 * skill's name from frontmatter when it is present and from the filename when it is not, so putting
 * it in frontmatter is what lets a professor rename a skill without the id underneath it moving —
 * the same separation `AssistantSkill` spends a comment on.
 *
 * ⚠ THE DIRECTORY IS CLEARED FIRST, WHICH IS THE WHOLE REASON THIS IS SAFE TO RUN AT EVERY LAUNCH.
 * A skill a professor removed has to stop being offered, and a stale file nobody rewrites is
 * exactly the failure this fork just spent a session cleaning up out of the demo projects.
 *
 * ⚠ IT WRITES UNDER `userData` RATHER THAN INTO THE STUDENT'S REPOSITORY. An earlier implementation
 * generated course rules into each project's `.opencode/`, which put the product's own state inside
 * work the student commits — and left it there after the feature was abandoned.
 */
export function writeCourseSkills(userDataPath: string): string | undefined {
  const dir = join(userDataPath, "jolli-skills")
  rmSync(dir, { recursive: true, force: true })

  const rows = ASSISTANTS.flatMap((assistant) =>
    assistant.skills.map((skill) => ({ assistant, skill })),
  )
  if (rows.length === 0) return undefined

  mkdirSync(dir, { recursive: true })
  for (const { assistant, skill } of rows) {
    /* The description is what the server shows when it lists what is available, so it names the
       assistant the procedure belongs to — a student may hold sessions with more than one. */
    /**
     * ⚠ `name` IS THE SLUG AND NOT THE PROFESSOR'S TITLE, WHICH IS THE OPPOSITE OF WHAT IT LOOKS
     * LIKE IT SHOULD BE. opencode uses a skill's name as its slash command, so writing "Process
     * Coaching" there produces `/Process Coaching` — a command with a space in it, which a student
     * cannot type. The human title goes in `description`, which is what the picker shows.
     *
     * The web mock derives the same slug for the same reason and states the rule this follows:
     * derive a LABEL from a name, never a KEY. Here the slug is the key, so it comes off `skillId`
     * — the field that is already stable under a rename — rather than off the title.
     */
    const front =
      "---\n" +
      "name: " + JSON.stringify(skill.skillId) + "\n" +
      "description: " + JSON.stringify(skill.name + " — " + assistant.name) + "\n" +
      "---\n\n" +
      skill.instructions +
      "\n"
    /**
     * ⚠ ONE DIRECTORY PER SKILL, EACH HOLDING A FILE NAMED LITERALLY `SKILL.md`, AND THE FILENAME IS
     * THE WHOLE POINT. The server the desktop actually spawns is the v1 one
     * (`packages/opencode/dist/node`, reached through `virtual:opencode-server`), and v1 scans a
     * configured `skills.paths` entry with its `SKILL_PATTERN` — any-depth `SKILL.md` and nothing
     * else (`packages/opencode/src/skill/index.ts`). Flat `<id>.md` files here matched nothing, so
     * the skills silently never appeared and never reached the slash list.
     *
     * ⚠ DO NOT "SIMPLIFY" THIS BACK TO ONE FILE PER SKILL. The v2 loader in
     * `packages/core/src/skill.ts` also accepts a top-level `.md` file, so the flat form looks
     * correct right up until you notice which half of the repo actually serves this app.
     *
     * ⚠ THE DIRECTORY NAME CARRIES THE ASSISTANT AND THE SKILL, while the frontmatter `name` stays
     * the bare `skillId`. v1 takes a skill's name only from frontmatter, so the directory is free to
     * disambiguate two assistants that ever ship the same `skillId` without moving the slash command.
     */
    const slug = assistant.id + "." + skill.skillId
    mkdirSync(join(dir, slug), { recursive: true })
    writeFileSync(join(dir, slug, "SKILL.md"), front, "utf8")
  }
  return dir
}
