/**
 * THE MODELS JOLLI RUNS, DECLARED AS OPENCODE'S OWN CONFIG.
 *
 * ⚠ THE STUDENT DOES NOT CHOOSE A PROVIDER, EVER. They sign in to Jolli and Jolli decides what they
 * may run — that is the product. So rather than hiding provider screens one at a time in the
 * renderer, this removes the subject: `enabled_providers` names exactly one provider, so every list
 * the app builds — the composer's picker, the model dialogs, the settings panes — is already empty
 * of anything else before a component reads it. A screen we forget to hide has nothing to show.
 *
 * ⚠ IT IS UPSTREAM'S MECHANISM, NOT A FORK OF ONE. `enabled_providers`, `provider.<id>.models` and
 * per-model routing are how OpenCode has always let a gateway declare its catalogue
 * (`packages/opencode/src/provider/provider.ts`). The real product ships this same shape from the
 * gateway's `.well-known/opencode`; this file is the stand-in until that exists (jolli/PLAN.md).
 *
 * ⚠ IT ARRIVES AS `JOLLICODE_CONFIG_CONTENT`, WHICH IS THE STRONGEST LAYER. Config merges
 * well-known → global → custom → project → this (`config/config.ts`), so a student who writes an
 * `opencode.json` into their coursework repository cannot widen the list. That inversion is the
 * whole credibility problem in jolli/PLAN.md's Phase 3, and for the model surface it is closed here.
 *
 * ⚠ THE CATALOGUE LIVES IN `@opencode-ai/app/jolli/model-catalog` (`MODEL_CATALOG`), NOT HERE. A
 * customer shown both halves of this product must meet one list of models, and the coaching heuristic
 * reads the same tiers — so the list is defined once and both surfaces import it. Ids and labels are
 * the web mock's, row for row; here `tier` survives only as the routing key below.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Brand } from "@opencode-ai/app/brand"
import { ASSISTANTS } from "@opencode-ai/app/jolli/fixtures"
import { MODEL_CATALOG, type ModelTier } from "@opencode-ai/app/jolli/model-catalog"

/**
 * WHICH REAL ENDPOINT ANSWERS, AND AS WHOM. Defaults to the Jolli gateway (`Brand.gatewayUrl`, the one
 * source of truth for the endpoint), overridable at BUILD time via `JOLLICODE_GATEWAY_URL` /
 * `JOLLICODE_GATEWAY_KEY` (electron.vite define). It is deliberately NOT a runtime env var: the gateway
 * is the model lockdown, and a runtime var would be inherited from the student's shell (`preferAppEnv`)
 * and let them repoint it — see the scrub in `server.ts`.
 */
const GATEWAY_URL = import.meta.env.JOLLICODE_GATEWAY_URL || Brand.gatewayUrl
const GATEWAY_KEY = import.meta.env.JOLLICODE_GATEWAY_KEY || "public"

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
 * ⚠ FOLLOW-UP (deliberately not done here): `GATEWAY_URL` now defaults to the real gateway
 * (`Brand.gatewayUrl`, build-overridable), but `ROUTE` and the `public` key still rewrite every send to
 * a free OpenCode Zen model. Deleting `ROUTE` (and sending the catalogue id directly) is the remaining
 * step to end the pretence once the real gateway serves the catalogue ids — tracked separately.
 */
const ROUTE: Record<ModelTier, string> = {
  premium: "big-pickle",
  standard: "nemotron-3.5-lightning-free",
  economy: "ling-3.0-flash-fin-free",
}

/**
 * ⚠ ONE PROVIDER, WHERE THE WEB MOCK GROUPS BY VENDOR. Its picker lists models under Anthropic,
 * OpenAI and Google; this one lists them under "Jolli", because on this surface Jolli IS the
 * provider — it is who the student signed in to and who answers. The vendor is still legible: it is
 * the first word of every model's name. Splitting into three would have meant declaring models on
 * the real `anthropic`/`openai`/`google` provider ids, which drag their whole models.dev catalogue
 * in behind them and expect their own wire formats.
 */
const PROVIDER_ID = "jolli"

/** The config the sidecar server is started with, as JSON. */
export function jolliGatewayConfig(skillsDir?: string): string {
  return JSON.stringify({
    /**
     * ⚠ WHERE THE COURSE'S PROCEDURES COME FROM, AND IT IS UPSTREAM'S MECHANISM RATHER THAN A FORK
     * OF ONE — the same posture `enabled_providers` takes above. The v1 server scans every path
     * listed here for files named literally `SKILL.md`, at any depth below it, so a professor's
     * skill is an ordinary skill to the server and needs no special case anywhere in it.
     * `writeCourseSkills` lays the files out to match, and says there why nothing looser will do.
     *
     * ⚠ THE DIRECTORY IS DERIVED AND REWRITTEN AT EVERY LAUNCH (`writeCourseSkills`), never authored.
     * The rows live on the assistant in `jolli/fixtures.ts`, which is the one place they are written
     * down; these files are that data in the shape the server reads. Editing them by hand lasts
     * until the next start.
     *
     * ⚠ IT IS THE V1 SHAPE — `{ paths: [...] }`, NOT A BARE ARRAY — AND THAT IS NOT A GUESS. Two
     * config schemas live in this repo: v1 takes `skills: { paths, urls }`, v2 takes a flat
     * `skills: string[]`. `enabled_providers` above is a v1 key and the model lockdown demonstrably
     * works, so this config is parsed as v1. A flat array here validates against nothing, fails
     * silently, and the skills simply never appear — which is exactly how it failed the first time.
     *
     * ⚠ AND IT IS OMITTED RATHER THAN EMPTY WHEN THERE IS NOTHING TO DECLARE, because an empty path
     * list is still a list the server walks and logs about.
     */
    ...(skillsDir ? { skills: { paths: [skillsDir] } } : {}),
    /**
     * ⚠ THE WHOLE LOCKDOWN IS THIS ONE LINE. Everything else here is a catalogue; this is what makes
     * the catalogue the only one. Removing it does not "show more models", it re-opens BYO keys.
     */
    enabled_providers: [PROVIDER_ID],
    provider: {
      [PROVIDER_ID]: {
        name: "Jolli",
        api: GATEWAY_URL,
        options: { apiKey: GATEWAY_KEY, baseURL: GATEWAY_URL },
        models: Object.fromEntries(
          MODEL_CATALOG.map(({ id, label, tier }) => [id, { name: label, id: ROUTE[tier] }]),
        ),
      },
    },
  })
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
