/**
 * THE SIGNED-IN STUDENT'S TOKEN, FROM WHICHEVER PLACE THIS PROCESS KEEPS IT.
 *
 * ⚠ TWO SURFACES, TWO STORES, AND NEITHER IS WRONG. The bare CLI signs in through
 * `plugin/jolli.ts`, which puts the JWT in `auth.json` under the provider id, and the provider
 * resolver reads it back from there. The desktop signs in from the Electron main process and keeps
 * the token encrypted in the OS keychain instead — it never reaches `auth.json` — so the sidecar
 * is handed it in its environment, which `createSidecarEnv()` scrubs of anything inherited first.
 *
 * ⚠ THE ENV KEYS ARE READ WITHOUT THE `OPENCODE_` ALIAS, DELIBERATELY. `Flag.env()` accepts a
 * legacy `OPENCODE_`-prefixed spelling for compatibility, and a credential is the one thing that
 * must not have a second name an outer shell could set.
 */
import { Brand } from "@opencode-ai/core/brand"
import { clearCatalogCache } from "@opencode-ai/core/jolli/cache"
import { Effect } from "effect"
import type { Auth } from "@/auth"

export interface JolliCredential {
  readonly token: string
  /** The student's tenant, e.g. `https://acme.jolli.ai`. Absent on a backend that predates it. */
  readonly baseUrl?: string
}

const TOKEN_ENV = "JOLLICODE_JOLLI_TOKEN"
const BASE_URL_ENV = "JOLLICODE_JOLLI_BASE_URL"

/**
 * ⚠ THE ENVIRONMENT WINS. Only the desktop sets it, and when it does it is the authority: its
 * sidecar has no `auth.json` entry to fall back to, and a stale one from an earlier CLI sign-in on
 * the same machine would authenticate as the wrong account.
 */
export function jolliCredential(stored: Auth.Info | undefined): JolliCredential | undefined {
  const token = process.env[TOKEN_ENV]?.trim()
  if (token) {
    const baseUrl = process.env[BASE_URL_ENV]?.trim()
    return { token, ...(baseUrl ? { baseUrl } : {}) }
  }
  if (stored?.type !== "api" || !stored.key) return undefined
  const baseUrl = stored.metadata?.["baseUrl"]
  return { token: stored.key, ...(baseUrl ? { baseUrl } : {}) }
}

/** The env keys the desktop passes down, for `createSidecarEnv()` to scrub before setting them. */
export const JOLLI_CREDENTIAL_ENV = [TOKEN_ENV, BASE_URL_ENV] as const

/** The auth.json key a Jolli credential is stored under. */
export const JOLLI_AUTH_KEY = Brand.short

/**
 * DROP THE CACHED COURSE CATALOGUE WHEN THE CREDENTIAL IT BELONGS TO GOES AWAY.
 *
 * ⚠ REMOVING THE CREDENTIAL IS NOT ENOUGH, AND THE CACHE KEY IS WHY IT LOOKS AS THOUGH IT WERE.
 * A snapshot is filed under a hash of the token, so once that token is gone nothing will ever SERVE
 * this student's courses again — but the file is still their course codes, their instructors'
 * assistant names and their model grants, sitting in a directory the next account on this machine
 * can read. Keyed storage stops a stale snapshot being served; only deleting it stops one being
 * found. The desktop has always done this on `jolliSignOut`; the CLI and the HTTP route did not,
 * which is the gap this closes.
 *
 * ⚠ IT IS A HELPER RATHER THAN A LINE IN `Auth.remove` BECAUSE THAT FILE IS UPSTREAM'S. Every line
 * this fork adds there is a line that conflicts on the next rebase, and the rule is a Jolli one:
 * removing any OTHER provider's credential has nothing to say about a course catalogue.
 *
 * ⚠ AND IT NEVER FAILS. Sign-out has already happened by the time this runs — a cache file that
 * would not delete is not a reason to tell somebody their sign-out did not work.
 */
export const forgetJolliCatalog = Effect.fn("Jolli.forgetCatalog")(function* (providerID: string) {
  if (providerID !== JOLLI_AUTH_KEY) return
  yield* clearCatalogCache()
})
