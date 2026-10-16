import { CourseSkillName } from "@opencode-ai/schema/course-skill-name"
import path from "path"
import { Effect, Schema } from "effect"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Skill } from "../skill"
import * as Tool from "./tool"
import DESCRIPTION from "./skill.txt"
import { isJolliProviderId } from "@opencode-ai/core/jolli/gateway-config"
import { MessageV2 } from "../session/message-v2"
import { Database } from "@opencode-ai/core/database/database"
import { JolliSkills } from "@opencode-ai/core/jolli/skills"
import { Session } from "../session/session"
import { JolliSession } from "@opencode-ai/core/jolli/session"

export const Parameters = Schema.Struct({
  name: Schema.String.annotate({ description: "The name of the skill from available_skills" }),
})

export const SkillTool = Tool.define(
  "skill",
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const ripgrep = yield* Ripgrep.Service
    const sessions = yield* Session.Service
    const jolli = yield* JolliSession.Service
    const database = yield* Database.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (
        params: Schema.Schema.Type<typeof Parameters>,
        ctx: Tool.Context,
      ): Effect.Effect<Tool.ExecuteResult<{ name: string; dir?: string; source?: string }>> =>
        Effect.gen(function* () {
          const session = yield* Effect.gen(function* () {
            if (!CourseSkillName.isCourse(params.name)) return undefined
            return yield* sessions.get(ctx.sessionID)
          })
          const authorize = ctx.ask({
            permission: "skill",
            patterns: [params.name],
            always: [params.name],
            metadata: {},
          })
          if (session) {
            const callID = ctx.callID
            if (!callID) return yield* Effect.die(new Error("Course skill invocation requires a tool call ID"))
            const current = yield* MessageV2.getInfo({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
              Effect.provideService(Database.Service, database),
            )
            if (current.role !== "assistant" || !isJolliProviderId(current.providerID))
              return yield* Effect.die(new Error("Course skills require a Jolli gateway model"))
            const selected = yield* JolliSkills.select(jolli, session, params.name)
            yield* authorize
            const reference = yield* JolliSkills.invoke(
              jolli,
              session,
              selected,
              callID,
              ctx.messages.findLast((message) => message.info.role === "user")?.info.id,
              typeof ctx.extra?.codingToolIndex === "number"
                ? { messageId: ctx.messageID, toolIndex: ctx.extra.codingToolIndex }
                : undefined,
            )
            return {
              title: `Loaded skill: ${params.name}`,
              output: JolliSkills.render(reference),
              metadata: { name: params.name, source: "course" },
            }
          }
          const info = yield* skill
            .require(params.name)
            .pipe(Effect.catchTag("Skill.NotFoundError", (error) => Effect.die(new Error(error.message))))

          yield* authorize

          const dir = path.dirname(info.location)
          const base = dir
          const files = yield* ripgrep.find({
            cwd: dir,
            pattern: "!**/SKILL.md",
            hidden: true,
            follow: false,
            signal: ctx.abort,
            limit: 10,
          })

          return {
            title: `Loaded skill: ${info.name}`,
            output: [
              `<skill_content name="${info.name}">`,
              `# Skill: ${info.name}`,
              "",
              info.content.trim(),
              "",
              `Base directory for this skill: ${base}`,
              "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
              "Note: file list is sampled.",
              "",
              "<skill_files>",
              files.map((file) => `<file>${path.resolve(dir, file.path)}</file>`).join("\n"),
              "</skill_files>",
              "</skill_content>",
            ].join("\n"),
            metadata: {
              name: info.name,
              dir,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
