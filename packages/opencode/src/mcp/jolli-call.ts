/**
 * THE ORG AN MCP CALL IS MADE IN, CARRIED FROM THE CALLER TO THE TRANSPORT'S `fetch`.
 *
 * ⚠ ONE CONNECTION SERVES EVERY SESSION. The course server is connected once per instance and its
 * `fetch` is fixed at connect time, so nothing in the request it is handed says which conversation
 * asked. The caller names the org of the session it is acting for around the line that starts a
 * call, and the `fetch` reads it back from async context.
 *
 * ⚠ THE ORG, NOT THE SESSION. Every caller already holds the session it acts for, so it reads the
 * org off that session's binding itself; the `fetch` then needs no session read of its own, which
 * would be a database round trip on every request and a failure path with no right answer.
 *
 * ⚠ THE CALL HAS TO START INSIDE `run`. The SDK sends a request from the promise chain the call
 * begins, and every step from there to `fetch` is an await on that chain, so the context set here is
 * still current when the request goes out. Work the transport started earlier — the handshake, the
 * tool listing, a stream opened at connect — runs outside any `run` and names no org.
 *
 * ⚠ SERVER-SIDE ONLY. `async_hooks` has no browser build, so this lives in this package rather than
 * next to `jolliMcpFetch` in core, which the app's bundle reaches through `core/jolli/sources`.
 */
import { AsyncLocalStorage } from "async_hooks"
import type { OrgScope } from "@opencode-ai/core/jolli/org-scoped-id"

export type McpCall = { readonly org: OrgScope | undefined }

const storage = new AsyncLocalStorage<McpCall>()

export const JolliMcpCall = {
  run<R>(call: McpCall, fn: () => R): R {
    return storage.run(call, fn)
  },
  /** The call in progress, or undefined outside any — never an error. */
  current(): McpCall | undefined {
    return storage.getStore()
  },
}
