import { describe, expect, test } from "bun:test"
import { shouldOpenDefaultProject } from "./first-launch"

const freshInstall = { hasProjects: false, initialUrl: "/", openTabs: 0 }

describe("desktop first launch default project", () => {
  /**
   * THE REGRESSION THIS FILE EXISTS FOR. The old rule also required every configured server to be
   * the bundled `variant: "base"` sidecar, which no Windows machine with a WSL distribution can
   * satisfy — and because the pending flag is consumed either way, those students never got a
   * default project at all, on that launch or any later one. A fresh install now says yes on the
   * three facts that describe the WINDOW, none of which a WSL distribution can change.
   */
  test("opens the default project on a fresh install", () => {
    expect(shouldOpenDefaultProject(freshInstall)).toBe(true)
  })

  test("leaves a student who already has a project alone", () => {
    expect(shouldOpenDefaultProject({ ...freshInstall, hasProjects: true })).toBe(false)
  })

  /**
   * ⚠ THE CASE THE `existingInstall` RULE GOT WRONG. A profile that has been launched before — any
   * `*.dat` or `window-state-*.json` in the user-data directory — reads as an upgrade to
   * `hasExistingAppState`, and used to be refused a default project even with no project to work
   * in. That is precisely a student signing in for the first time on a machine the app has already
   * been opened on.
   */
  test("opens the default project for a used profile that has no project", () => {
    expect(shouldOpenDefaultProject({ hasProjects: false, initialUrl: "/", openTabs: 0 })).toBe(true)
  })

  test("does not open a draft over a restored route", () => {
    expect(shouldOpenDefaultProject({ ...freshInstall, initialUrl: "/session/ses_123" })).toBe(false)
  })

  test("does not open a draft over restored tabs", () => {
    expect(shouldOpenDefaultProject({ ...freshInstall, openTabs: 1 })).toBe(false)
  })
})
