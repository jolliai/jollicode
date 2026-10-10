import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearCourseSkills, jolliGatewayConfig } from "./jolli-gateway"

const roots: string[] = []
const ENABLED_PROVIDERS = ["jolli-anthropic", "jolli-openai", "jolli-google", "jolli-openai-compatible"]

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "jolli-gateway-"))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/**
 * What the sidecar server is started with. It outranks anything a student writes in their repo.
 *
 * ⚠ IT IS A CEILING AND NOTHING ELSE NOW. The credential and the model list both come from the
 * server's own floor, read out of the database this process shares with the bare CLI — so these
 * tests are about what a coursework repository cannot change, not about who is signed in.
 */
describe("jolliGatewayConfig", () => {
  const config = () => JSON.parse(jolliGatewayConfig())

  test("locks the provider list to the protocol providers this install may reach", () => {
    expect(config().enabled_providers).toEqual(ENABLED_PROVIDERS)
  })

  test("declares a provider block per protocol, because those blocks pin the endpoints", () => {
    /**
     * ⚠ THE BLOCK IS UNCONDITIONAL HERE AND CONDITIONAL AT THE SERVER, AND THAT SPLIT IS THE
     * DESIGN. This process cannot know who is signed in without holding a credential, which is
     * exactly what it stopped doing. So it always declares the ceiling — `baseURL` and `npm`, the
     * two values a repository must not be able to move — and the server's post-merge pass removes
     * the whole block when nobody is signed in.
     */
    expect(Object.keys(config().provider)).toEqual(ENABLED_PROVIDERS)
    for (const id of ENABLED_PROVIDERS) expect(config().provider[id].options.baseURL).toBeTruthy()
    // One SDK per protocol: the npm is what makes the URL the SDK builds match the gateway's route.
    expect(config().provider["jolli-anthropic"].npm).toBe("@ai-sdk/anthropic")
    expect(config().provider["jolli-openai"].npm).toBe("@ai-sdk/openai")
    expect(config().provider["jolli-google"].npm).toBe("@ai-sdk/google")
    expect(config().provider["jolli-openai-compatible"].npm).toBe("@ai-sdk/openai-compatible")
  })

  test("never carries a credential", () => {
    /**
     * ⚠ THIS ASSERTION IS THE INVERSE OF THE ONE IT REPLACED. The desktop used to pass its JWT
     * through here because its sidecar had no `auth.json` entry to read. Provider options are
     * resolved once and cached for the life of the process, so a token written here would be stale
     * within one token lifetime — and would be a value a coursework repo could overwrite, which is
     * an identity swap rather than a nuisance. The provider's own `fetch` resolves it per request.
     */
    for (const id of ENABLED_PROVIDERS) expect(config().provider[id].options).not.toHaveProperty("apiKey")
  })

  test("declares no models at all, leaving them to the server's own floor", () => {
    /**
     * ⚠ ABSENT, NOT EMPTY, AND THE DIFFERENCE IS WHAT MAKES THE DESIGN WORK. This object is the TOP
     * config layer; remeda's `mergeDeep` keeps a key the top layer does not set, so omitting
     * `models` is what lets the server supply the tenant's catalogue underneath. Declaring an empty
     * object would say the wrong thing about intent even though it would merge the same way.
     */
    for (const id of ENABLED_PROVIDERS) expect(config().provider[id]).not.toHaveProperty("models")
  })

  test("declares no skills directory, because there are no skills to declare", () => {
    expect(config().skills).toBeUndefined()
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
