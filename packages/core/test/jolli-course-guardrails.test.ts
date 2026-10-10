import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { Effect } from "effect"
import { Global } from "../src/global"
import type { GatewayRequest } from "../src/jolli/api"
import { CATALOG_SCHEMA, catalogCachePath } from "../src/jolli/cache"
import { JolliCourseGuardrails } from "../src/jolli/course-guardrails"

const binding = { courseId: "7", assistantId: "12" }
const request = (origin: string): GatewayRequest => ({ origin, token: "jwt", identity: "student-a" })
const written: string[] = []

/** A fresh catalogue on disk, so the read is answered without a network round trip. */
async function seedCatalog(origin: string, assistants: Record<string, unknown[]>) {
  const file = catalogCachePath(request(origin))
  await mkdir(Global.Path.cache, { recursive: true })
  await writeFile(
    file,
    JSON.stringify({
      schema: CATALOG_SCHEMA,
      courses: [
        {
          id: 7,
          name: "Systems Programming",
          description: "From the catalogue.",
          code: "CS 310",
          status: "published",
          requiresCoding: true,
          endsOn: null,
          viewerRole: "course-student",
          isStaff: false,
        },
      ],
      assistants,
      models: [],
    }),
  )
  written.push(file)
}

const choice = (id: number, showCitations: boolean) => ({
  id,
  name: "Pair programmer",
  blurb: "Works through the problem with you",
  icon: "Terminal",
  accent: 0,
  worksThroughProblems: true,
  answersFromMaterialsOnly: true,
  showCitations,
  modelId: "uuid-opus",
  allowedModelIds: ["uuid-opus"],
})

afterEach(async () => {
  await Promise.all(written.splice(0).map((file) => rm(file, { force: true })))
})

describe("JolliCourseGuardrails.resolve", () => {
  test("reads the bound assistant's switches off the student's catalogue", async () => {
    const origin = "https://course-guardrails.invalid"
    await seedCatalog(origin, { "7": [choice(12, true)] })
    const guardrails = await Effect.runPromise(JolliCourseGuardrails.resolve({ request: request(origin), binding }))
    expect(guardrails).toMatchObject({ restrictToMaterials: true, showCitations: true })
  })

  test("does not know an assistant the catalogue does not hold for this course", async () => {
    const origin = "https://course-guardrails-unknown.invalid"
    await seedCatalog(origin, { "7": [choice(99, true)] })
    const guardrails = await Effect.runPromise(JolliCourseGuardrails.resolve({ request: request(origin), binding }))
    expect(guardrails).toBeUndefined()
  })

  test("does not know anything without a credential", async () => {
    expect(await Effect.runPromise(JolliCourseGuardrails.resolve({ request: undefined, binding }))).toBeUndefined()
  })
})
