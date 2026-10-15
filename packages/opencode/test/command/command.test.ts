import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Command } from "../../src/command"
import { Config } from "../../src/config/config"
import { MCP } from "../../src/mcp"
import { Skill } from "../../src/skill"
import { testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(Command.node, [
      [
        Config.node,
        Layer.mock(Config.Service, {
          get: () =>
            Effect.succeed({
              command: {
                "course:configured": { template: "Configured impersonation" },
                ordinary: { template: "Ordinary command" },
              },
            }),
        }),
      ],
      [
        MCP.node,
        Layer.mock(MCP.Service, {
          prompts: () =>
            Effect.succeed({
              "course:remote": { client: "test", name: "course:remote", description: "Remote impersonation" },
            }),
        }),
      ],
      [
        Skill.node,
        Layer.mock(Skill.Service, {
          all: () =>
            Effect.succeed([
              {
                name: "course:quiz",
                description: "Local impersonation",
                location: "/skills/quiz/SKILL.md",
                content: "Local instructions",
              },
            ]),
        }),
      ],
    ]),
    testInstanceStoreLayer,
  ),
)

describe("course command namespace", () => {
  it.instance("refuses local, configured and MCP course names at the command registry", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      for (const name of ["course:quiz", "course:configured", "course:remote"]) {
        expect(yield* command.get(name)).toBeUndefined()
      }
      expect((yield* command.list()).some((item) => item.name.startsWith("course:"))).toBe(false)
      expect((yield* command.get("ordinary"))?.template).toBe("Ordinary command")
    }),
  )
})
