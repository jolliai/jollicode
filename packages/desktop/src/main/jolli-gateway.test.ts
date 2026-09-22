import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import { clearCourseSkills, jolliGatewayConfig } from "./jolli-gateway"

const roots: string[] = []
const TENANT = "https://gateway-config-test.jolli.ai"
const TOKEN = "jwt"
const ENABLED_PROVIDERS = ["jolli-anthropic", "jolli-openai", "jolli-google"]

async function seedCatalog() {
  const file = join(Global.Path.cache, `jolli-catalog-${Hash.fast(`${TENANT}||${TOKEN}`)}.json`)
  await mkdir(Global.Path.cache, { recursive: true })
  await writeFile(
    file,
    JSON.stringify({
      schema: 2,
      courses: [],
      assistants: {},
      models: [
        {
          id: "uuid-opus",
          name: "claude-opus-4-8",
          category: "Premium",
          description: null,
          isActive: true,
          protocol: "anthropic",
        },
      ],
    }),
  )
  roots.push(file)
}

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
  test("locks the provider list but declares no provider while signed out", async () => {
    const config = JSON.parse(await jolliGatewayConfig({ signedIn: false }))
    expect(config.enabled_providers).toEqual(ENABLED_PROVIDERS)
    // A provider block here reports as connected, so first-run sign-in would never trigger.
    expect(config.provider).toBeUndefined()
  })

  test("points the signed-in student at their own tenant", async () => {
    await seedCatalog()
    const config = JSON.parse(await jolliGatewayConfig({ signedIn: true, authToken: TOKEN, baseUrl: TENANT }))
    expect(config.provider["jolli-anthropic"].options.baseURL).toBe(`${TENANT}/api/v1`)
  })

  test("carries the student's token, because the sidecar has no auth.json to read it from", async () => {
    // Sign-in happens in the Electron main process, not through the provider plugin, so without
    // this the provider resolves with no credential, reports as connected, and 401s on first send.
    await seedCatalog()
    const config = JSON.parse(await jolliGatewayConfig({ signedIn: true, authToken: TOKEN, baseUrl: TENANT }))
    expect(config.provider["jolli-anthropic"].options.apiKey).toBe(TOKEN)
    // Signed out there is no provider block at all, so there is nowhere for a stale key to hide.
    expect(JSON.parse(await jolliGatewayConfig({ signedIn: false, authToken: TOKEN })).provider).toBeUndefined()
  })

  test("declares no models when the tenant catalogue cannot be had", async () => {
    /**
     * ⚠ NO MODELS RATHER THAN A LOCAL LIST, AND THE DIFFERENCE IS VISIBLE TO A STUDENT. The old
     * fallback declared `MODEL_CATALOG`, which names models by name while a course grants them by
     * Registry UUID — so every model failed the grant and the picker came up empty with nothing to
     * explain it. An empty block is the same emptiness with the cause left intact.
     */
    const config = JSON.parse(await jolliGatewayConfig({ signedIn: true, authToken: "jwt" }))
    expect(config.provider).toEqual({})
    expect(config.enabled_providers).toEqual(ENABLED_PROVIDERS)
  })

  test("declares no skills directory, because there are no skills to declare", async () => {
    const config = JSON.parse(await jolliGatewayConfig({ signedIn: true }))
    expect(config.skills).toBeUndefined()
  })
})

/**
 * ⚠ IT ONLY CLEARS. Courses and assistants come from the gateway, whose student-facing
 * assistant shape carries no skills — jolliedu has no such concept — so there is nothing to
 * materialise. What is left is the cleanup, which is load-bearing for anyone upgrading from a build
 * that DID write these: a stale `SKILL.md` under `userData` would keep being discovered and offered
 * as a slash command by a professor who never wrote it.
 */
describe("clearCourseSkills", () => {
  test("is a no-op when an install never wrote any", async () => {
    const root = await tempRoot()
    expect(() => clearCourseSkills(root)).not.toThrow()
  })

  test("removes skills an earlier build materialised", async () => {
    const root = await tempRoot()
    const stale = join(root, "jolli-skills", "cs-310-code.read-the-error")
    await mkdir(stale, { recursive: true })
    await writeFile(join(stale, "SKILL.md"), "---\nname: read-the-error\n---\n")

    clearCourseSkills(root)
    await expect(readdir(join(root, "jolli-skills"))).rejects.toThrow()
  })
})
