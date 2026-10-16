export * as SkillGuidance from "./guidance"

import { makeLocationNode } from "../effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { PermissionV2 } from "../permission"
import { SkillV2 } from "../skill"
import { SystemContext } from "../system-context/index"
import { JolliSkills } from "../jolli/skills"
import { JolliSession } from "../jolli/session"
import { escapeHtml } from "../util/html"

const Summary = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
})
type Summary = typeof Summary.Type

const render = (skills: ReadonlyArray<Summary>) =>
  [
    "Skills provide specialized instructions and workflows for specific tasks.",
    "Use the skill tool to load a skill when a task matches its description.",
    ...(skills.some((skill) => JolliSkills.isCourse(skill.name))
      ? ["When the user names a /course: command, load that course skill before carrying out the request."]
      : []),
    ...(skills.length === 0
      ? ["No skills are currently available."]
      : [
          "<available_skills>",
          ...skills.flatMap((skill) => [
            "  <skill>",
            `    <name>${escapeHtml(skill.name)}</name>`,
            `    <description>${escapeHtml(skill.description)}</description>`,
            "  </skill>",
          ]),
          "</available_skills>",
        ]),
  ].join("\n")

export interface Interface {
  readonly load: (
    agent: AgentV2.Selection,
    session?: JolliSkills.Session,
    refresh?: boolean,
  ) => Effect.Effect<SystemContext.SystemContext>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SkillGuidance") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skills = yield* SkillV2.Service
    const jolli = yield* JolliSession.Service

    return Service.of({
      load: Effect.fn("SkillGuidance.load")(function* (selection, session, refresh = false) {
        const agent = selection.info
        if (!agent) return SystemContext.empty
        const local = SkillV2.available(yield* skills.list(), agent)
        const exceptions = agent.permissions.some(
          (rule) =>
            rule.effect !== "deny" &&
            PermissionV2.evaluate("skill", rule.resource, agent.permissions).effect !== "deny",
        )
        if (
          local.length === 0 &&
          !exceptions &&
          PermissionV2.evaluate("skill", "*", agent.permissions).effect === "deny"
        )
          return SystemContext.empty
        const available = (course: JolliSkills.Summary[]) =>
          SkillV2.available(
            [
              ...local,
              ...course.map((skill) => ({ name: skill.toolName, description: skill.description || skill.name })),
            ],
            agent,
          )
            .flatMap((skill) =>
              skill.description === undefined ? [] : [{ name: skill.name, description: skill.description }],
            )
            .toSorted((a, b) => a.name.localeCompare(b.name))
        return SystemContext.make({
          key: SystemContext.Key.make("core/skill-guidance"),
          codec: Schema.toCodecJson(Schema.Array(Summary)),
          initial: () => available([]),
          load: JolliSkills.list(jolli, session, refresh).pipe(
            Effect.map(available),
            Effect.catch((error) =>
              Effect.logWarning("Jolli: course skill guidance unavailable", { sessionID: session?.id, error }).pipe(
                Effect.as(JolliSkills.isRefused(error) ? available([]) : SystemContext.unavailable),
              ),
            ),
          ),
          baseline: render,
          update: (_previous, current) =>
            [
              "The available skills have changed. This list supersedes the previous available skills list.",
              render(current),
            ].join("\n"),
          removed: () => "Skill guidance is no longer available. Do not use any previously listed skill.",
        })
      }),
    })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [SkillV2.node, JolliSession.node] })
