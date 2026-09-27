import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { Auth } from "../../src/auth"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Auth.node))

afterEach(() => {
  delete process.env.JOLLICODE_AUTH_CONTENT
})

describe("Auth", () => {
  it.instance("set normalizes trailing slashes in keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeDefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set cleans up pre-existing trailing-slash entry", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "old",
      })
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "new",
      })
      const data = yield* auth.all()
      const keys = Object.keys(data).filter((key) => key.includes("example.com"))
      expect(keys).toEqual(["https://example.com"])
      const entry = data["https://example.com"]!
      expect(entry.type).toBe("wellknown")
      if (entry.type === "wellknown") expect(entry.token).toBe("new")
    }),
  )

  it.instance("remove deletes both trailing-slash and normalized keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      yield* auth.remove("https://example.com/")
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeUndefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set and remove are no-ops on keys without trailing slashes", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("anthropic", {
        type: "api",
        key: "sk-test",
      })
      const data = yield* auth.all()
      expect(data["anthropic"]).toBeDefined()
      yield* auth.remove("anthropic")
      const after = yield* auth.all()
      expect(after["anthropic"]).toBeUndefined()
    }),
  )

  it.instance("all reads JOLLICODE_AUTH_CONTENT instead of the file", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("from-file", { type: "api", key: "file" })
      process.env.JOLLICODE_AUTH_CONTENT = JSON.stringify({ "from-env": { type: "api", key: "env" } })
      const data = yield* auth.all()
      expect(Object.keys(data)).toEqual(["from-env"])
      expect(data["from-env"]).toMatchObject({ type: "api", key: "env" })
    }),
  )

  it.instance("all falls back to the file when JOLLICODE_AUTH_CONTENT is invalid JSON", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("from-file", { type: "api", key: "file" })
      process.env.JOLLICODE_AUTH_CONTENT = "{not json"
      const data = yield* auth.all()
      expect(data["from-file"]).toMatchObject({ type: "api", key: "file" })
    }),
  )
})
