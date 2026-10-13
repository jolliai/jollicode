/**
 * `settleStart` DECIDES WHETHER A START IS RETRIED UNDER ITS ID FROM THE STATUS THE SDK THROWS WITH.
 *
 * ⚠ END TO END ON PURPOSE. The rule rests on a chain no unit test sees whole: the route answering 400,
 * the generated client throwing under `throwOnError`, and `wrapClientError` carrying the status under
 * `cause`. If any link stopped holding, every rejection would quietly turn back into "no answer".
 */
import { afterEach, describe, expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { settleStart } from "@opencode-ai/core/jolli/opener"
import { Server } from "../../src/server/server"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

function client(directory: string, fetch: (req: Request) => Response | Promise<Response>) {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the client only ever calls it with a Request.
  return createOpencodeClient({ baseUrl: "http://test", directory, fetch: fetch as unknown as typeof globalThis.fetch })
}

describe("settleStart", () => {
  test("a Start the route rejects is an answer, so the next one takes a new id", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const sdk = client(tmp.path, (req) => Server.Default().app.fetch(req))
    // Not a gateway id: the route refuses it before asking anyone.
    const answer = await settleStart(
      sdk.session.jolliStart({ courseId: "not-a-number", assistantId: "12" }, { throwOnError: true }),
    )
    expect(answer).toEqual({ result: undefined, unanswered: false })
  })

  test("a Start that never reached the sidecar is unanswered, so the next one keeps the id", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const sdk = client(tmp.path, () => {
      throw new TypeError("fetch failed")
    })
    const answer = await settleStart(
      sdk.session.jolliStart({ courseId: "7", assistantId: "12" }, { throwOnError: true }),
    )
    expect(answer).toEqual({ result: undefined, unanswered: true })
  })

  test("a sidecar that failed with a 5xx is unanswered", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const sdk = client(tmp.path, () => new Response("boom", { status: 500 }))
    const answer = await settleStart(
      sdk.session.jolliStart({ courseId: "7", assistantId: "12" }, { throwOnError: true }),
    )
    expect(answer).toEqual({ result: undefined, unanswered: true })
  })
})
