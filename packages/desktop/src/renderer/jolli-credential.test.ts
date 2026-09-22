import { describe, expect, test } from "bun:test"
import { JOLLI_PROVIDER_IDS } from "@opencode-ai/core/jolli/gateway-config"
import { Brand } from "@opencode-ai/app/brand"
import { createCredentialLatch } from "./jolli-credential"

const jolli = JOLLI_PROVIDER_IDS[0]!
const held = { ready: true, connected: [jolli] }
const gone = { ready: true, connected: ["anthropic"] }

describe("jolli credential latch", () => {
  test("reports a credential that was held and went", () => {
    const latch = createCredentialLatch()
    expect(latch(held)).toBe(false)
    expect(latch(gone)).toBe(true)
  })

  /**
   * THE REGRESSION THIS FILE EXISTS FOR. An empty `connected` is also what every launch looks like
   * before the first bootstrap settles, so a check without the latch raises the sign-in gate over a
   * student who is signed in — on every launch, for the handful of frames before the answer lands.
   * `dialog-logout.tsx` latches against the same trap and `jolli/catalog.ts` states the rule:
   * absent means "we cannot tell", not "signed out".
   */
  test("says nothing about a credential that has not arrived yet", () => {
    const latch = createCredentialLatch()
    expect(latch({ ready: true, connected: [] })).toBe(false)
    expect(latch({ ready: true, connected: [] })).toBe(false)
    expect(latch(held)).toBe(false)
  })

  test("waits for the bootstrap to settle before believing anything", () => {
    const latch = createCredentialLatch()
    expect(latch({ ready: false, connected: [jolli] })).toBe(false)
    // The unsettled read above must not have latched, so this is still "not arrived yet".
    expect(latch(gone)).toBe(false)
  })

  /**
   * ⚠ ONCE PER DISAPPEARANCE. The caller raises a gate; firing again on the next poll would reset
   * the screen under a student part-way through signing back in.
   */
  test("fires once per disappearance", () => {
    const latch = createCredentialLatch()
    latch(held)
    expect(latch(gone)).toBe(true)
    expect(latch(gone)).toBe(false)
    expect(latch(held)).toBe(false)
    expect(latch(gone)).toBe(true)
  })

  /**
   * ⚠ THE BARE AUTH SLUG IS NOT A CREDENTIAL SIGNAL — `/provider` reports one id per wire protocol
   * and `httpapi-provider.test.ts` asserts the slug is absent. Counting it here would latch on a
   * value that never arrives, which is the bug `isSignedIn` had in the main process.
   */
  test("does not count the bare auth slug as a held credential", () => {
    const latch = createCredentialLatch()
    expect(latch({ ready: true, connected: [Brand.short] })).toBe(false)
    expect(latch(gone)).toBe(false)
  })
})
