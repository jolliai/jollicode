/**
 * WHO THE HELD CREDENTIAL BELONGS TO, AS FAR AS THE CREDENTIAL ITSELF WILL SAY.
 *
 * The Jolli credential is a JWT (see `exchange.ts` and `gateway-config.ts`, both of which are
 * emphatic that it is a token and not an API key). Its payload names the student, which is enough to
 * label an account row without asking the gateway anything.
 *
 * ⚠ THE SIGNATURE IS NOT VERIFIED, AND THAT IS A DECISION RATHER THAN AN OVERSIGHT.
 *
 *   1. We already hold this token as a bearer credential and are about to send it. Anyone who can
 *      substitute the token can substitute a VALID one, so verifying locally raises no bar.
 *   2. The gateway verifies on every request and is the only verifier whose result has consequences.
 *   3. We do not have the signing key and should not fetch one. A JWKS dependency would add a
 *      network call, a key-rotation failure mode and a new reason for the sidebar to be blank — all
 *      to decide which word to draw.
 *   4. Failure is total and silent by construction: anything malformed returns `undefined` and the
 *      caller degrades to "Account".
 *
 * In-tree precedent: `src/plugin/provider/openai.ts` decodes an unverified payload for exactly this
 * class of purpose — labelling an account.
 *
 * ⚠ WHAT MAY NEVER BE BUILT ON THIS:
 *
 *   - NO AUTHORISATION DECISION MAY READ THESE CLAIMS. Not a role, not a staff flag, not a tenant.
 *     What a student may start comes from the gateway's course data (`Lookup.canStartSession`), and
 *     the gateway enforces every guardrail itself.
 *   - `exp` MUST NOT DECIDE "SIGNED OUT". An expired token still decodes cleanly, and clock skew
 *     would make a local verdict wrong. The gateway's 401 is the authority.
 *   - NO CLAIM MAY BECOME A URL OR AN IMAGE SOURCE. In particular, if a token ever carries
 *     `picture` or `avatar_url`, it is deliberately not read here: rendering it would make the app
 *     fetch an attacker-choosable origin on the strength of a payload we did not authenticate.
 *
 * ⚠ AND THE CLAIM NAMES ARE A GUESS UNTIL SOMEBODY CHECKS A REAL TOKEN. Nothing in this repository
 * records what the gateway puts in its payload, so the chains below cover the usual OIDC spellings
 * and fall back rather than assert. If a real token turns out to carry only `sub`, the fix is to add
 * a `fetchViewer` beside `fetchCourses` in `api.ts` and map it into this same shape — one function
 * body, with no change to the schema, the loader or the UI. That swap is why this is a single
 * function and not spread across callers.
 */

import { base64Decode } from "../util/encode"
import type { Jolli } from "@opencode-ai/schema/jolli"

/** Long enough for any real name or address; short enough that a pathological claim cannot bloat the DOM. */
const MAX_LENGTH = 120

export function viewerFromToken(token: string): Jolli.Viewer | undefined {
  const payload = decodePayload(token)
  if (!payload) return undefined

  const email = firstString(payload, ["email"]) ?? emailShaped(payload)
  const name =
    firstString(payload, ["name"]) ??
    joined(payload, "given_name", "family_name") ??
    firstString(payload, ["preferred_username", "nickname"]) ??
    localPart(email)

  if (!name && !email) return undefined
  return { ...(name ? { name } : {}), ...(email ? { email } : {}) }
}

function decodePayload(token: string): Record<string, unknown> | undefined {
  try {
    const segment = token.split(".")[1]
    if (!segment) return undefined
    /**
     * ⚠ `base64Decode` MAPS THE URL ALPHABET AND DECODES UTF-8 — so `José` and `李雷` survive — BUT
     * IT DOES NOT PAD. JWT segments are unpadded by spec, and `atob` rejects a length that is not a
     * multiple of four.
     */
    const padded = segment + "=".repeat((4 - (segment.length % 4)) % 4)
    const parsed: unknown = JSON.parse(base64Decode(padded))
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * ⚠ STRINGS ONLY, NEVER COERCED. A `name` that arrives as a number or an object must be ignored
 * rather than `String()`-ed, or the sidebar renders `[object Object]` at somebody.
 */
function text(value: unknown) {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, MAX_LENGTH)
}

function firstString(payload: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = text(payload[key])
    if (value) return value
  }
  return undefined
}

function joined(payload: Record<string, unknown>, first: string, last: string) {
  const parts = [text(payload[first]), text(payload[last])].filter(Boolean)
  if (parts.length === 0) return undefined
  return parts.join(" ").slice(0, MAX_LENGTH)
}

/** `preferred_username` is only an address when it looks like one; otherwise it is a handle. */
function emailShaped(payload: Record<string, unknown>) {
  const value = text(payload["preferred_username"])
  return value?.includes("@") ? value : undefined
}

/**
 * The part of an address before the `@`, and nothing at all when there is no `@` to be before.
 *
 * ⚠ THE `at > 0` GUARD IS LOAD-BEARING, AND ITS ABSENCE SILENTLY MISNAMED PEOPLE. `indexOf` answers
 * `-1` when the claim is not address-shaped, and `slice(0, -1)` is "everything but the last
 * character" rather than the empty string — so an `email` claim of `alice.smith` produced the name
 * `alice.smit` and the sidebar drew it at somebody. Nothing in this repository pins what the gateway
 * puts in that claim (see the header note), so "it will always contain an @" is not a fact we hold.
 *
 * ⚠ AND `> 0` RATHER THAN `>= 0`, so `@jolli.ai` yields no name instead of an empty one.
 */
function localPart(email: string | undefined) {
  if (!email) return undefined
  const at = email.indexOf("@")
  if (at <= 0) return undefined
  return text(email.slice(0, at))
}
