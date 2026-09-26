/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { define } from "./internal"
import { Effect } from "effect"
import { AbsolutePath } from "../schema"
import { SkillV2 } from "../skill"
import customizeJollicodeContent from "./skill/customize-jollicode.md" with { type: "text" }

export const CustomizeJollicodeContent = customizeJollicodeContent

export const Plugin = define({
  id: "skill",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.skill.transform((draft) => {
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "customize-jollicode",
            description:
              "Use ONLY when the user is editing or creating Jolli Code's own configuration: jollicode.json, jollicode.jsonc, files under .jollicode/, or files under ~/.config/jollicode/. Also use when creating or fixing Jolli Code agents, subagents, commands, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring Jolli Code itself.",
            location: AbsolutePath.make("/builtin/customize-jollicode.md"),
            content: CustomizeJollicodeContent,
          }),
        }),
      )
    })
  }),
})
