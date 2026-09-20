import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ASSISTANTS } from "@opencode-ai/app/jolli/fixtures"
import { MODEL_CATALOG } from "@opencode-ai/core/jolli/model-catalog"
import { jolliGatewayConfig, writeCourseSkills } from "./jolli-gateway"

const roots: string[] = []

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "jolli-gateway-"))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** What the sidecar server is started with. It outranks anything a student writes in their repo. */
describe("jolliGatewayConfig", () => {
  test("locks the provider list but declares no provider while signed out", () => {
    const config = JSON.parse(jolliGatewayConfig({ signedIn: false }))
    expect(config.enabled_providers).toEqual(["jolli"])
    // A provider block here reports as connected, so first-run sign-in would never trigger.
    expect(config.provider).toBeUndefined()
  })

  test("points the signed-in student at their own tenant", () => {
    const config = JSON.parse(jolliGatewayConfig({ signedIn: true, baseUrl: "https://acme.jolli.ai" }))
    expect(config.provider.jolli.options.baseURL).toBe("https://acme.jolli.ai/api")
  })

  test("carries the student's token, because the sidecar has no auth.json to read it from", () => {
    // Sign-in happens in the Electron main process, not through the provider plugin, so without
    // this the provider resolves with no credential, reports as connected, and 401s on first send.
    const config = JSON.parse(jolliGatewayConfig({ signedIn: true, authToken: "jwt" }))
    expect(config.provider.jolli.options.apiKey).toBe("jwt")
    // Signed out there is no provider block at all, so there is nowhere for a stale key to hide.
    expect(JSON.parse(jolliGatewayConfig({ signedIn: false, authToken: "jwt" })).provider).toBeUndefined()
  })

  test("routes every catalogue model to one that actually answers", () => {
    const models = JSON.parse(jolliGatewayConfig({ signedIn: true })).provider.jolli.models
    // The map keys stay the ids the course config and the UI use.
    expect(Object.keys(models)).toEqual(MODEL_CATALOG.map((model) => model.id))
    // Declared without a route, most of this catalogue would list beautifully and fail on send.
    expect(Object.values(models).every((model: { id?: string }) => !!model.id)).toBe(true)
    expect(models["claude-opus-5"].id).toBe("big-pickle")
    expect(models["claude-haiku-4-5"].id).toBe("ling-3.0-flash-fin-free")
  })

  test("declares the course skills in the v1 shape the server actually reads", () => {
    const config = JSON.parse(jolliGatewayConfig({ signedIn: true, skillsDir: "/tmp/jolli-skills" }))
    // A flat `skills: [...]` validates against nothing here and the skills silently never appear.
    expect(config.skills).toEqual({ paths: ["/tmp/jolli-skills"] })
    expect(JSON.parse(jolliGatewayConfig({ signedIn: true })).skills).toBeUndefined()
  })
})

describe("writeCourseSkills", () => {
  test("writes one SKILL.md per course skill, named by its slug", async () => {
    const dir = writeCourseSkills(await tempRoot())
    const expected = ASSISTANTS.flatMap((assistant) => assistant.skills.map((skill) => ({ assistant, skill })))
    expect(dir).toBeDefined()
    if (!dir) return

    // v1 scans a configured skills path for any-depth `SKILL.md` and nothing else.
    expect((await readdir(dir)).sort()).toEqual(
      expected.map(({ assistant, skill }) => `${assistant.id}.${skill.skillId}`).sort(),
    )

    const first = expected.at(0)
    if (!first) return
    const written = await readFile(join(dir, `${first.assistant.id}.${first.skill.skillId}`, "SKILL.md"), "utf8")
    // The slug is the slash command, so the professor's title goes in the description instead.
    expect(written).toContain(`name: ${JSON.stringify(first.skill.skillId)}`)
    expect(written).toContain(JSON.stringify(`${first.skill.name} — ${first.assistant.name}`))
    expect(written).toContain(first.skill.instructions)
  })

  test("clears skills a professor removed instead of leaving them offered", async () => {
    const root = await tempRoot()
    const stale = join(root, "jolli-skills", "cs-310.deleted-by-the-professor")
    await mkdir(stale, { recursive: true })
    await writeFile(join(stale, "SKILL.md"), "---\nname: gone\n---\n")

    const dir = writeCourseSkills(root)
    expect(dir).toBe(join(root, "jolli-skills"))
    expect(await readdir(dir ?? "")).not.toContain("cs-310.deleted-by-the-professor")
  })
})
