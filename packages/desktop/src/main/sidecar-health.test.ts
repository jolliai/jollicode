import { describe, expect, test } from "bun:test"
import { awaitSidecarReady } from "./sidecar-health"

describe("awaitSidecarReady", () => {
  test("reports a sidecar that answered", async () => {
    expect(await awaitSidecarReady(Promise.resolve(), 1000)).toEqual({ ready: true })
  })

  test("gives up on a sidecar that never answers rather than waiting on it", async () => {
    // The unbounded version of this is the hang that left the sign-in button spinning forever.
    expect(await awaitSidecarReady(new Promise(() => {}), 10)).toEqual({ ready: false })
  })

  test("reports a sidecar that died instead of throwing it at the caller", async () => {
    // The credential is already stored by the time anyone waits on this, so a rejection here must
    // not surface as a failed sign-in.
    const died = new Error("Sidecar exited before health check passed with code 1")
    expect(await awaitSidecarReady(Promise.reject(died), 1000)).toEqual({ ready: false, error: died })
  })
})
