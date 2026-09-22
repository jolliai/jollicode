import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { openSidebarSession, sidebarSession, SIDEBAR_SESSION_ROW } from "../utils/nav"

/**
 * DELETING A SESSION HAS TO REACH THE SIDEBAR, AND IT HAS TO NOT TAKE THE RENDERER WITH IT.
 *
 * ⚠ TWO SEPARATE REGRESSIONS, ONE FLOW. The Home session index the sidebar reads is a different
 * cache from the per-directory session store the timeline writes, and `deleteSession` only ever
 * wrote the second — so a deleted session stayed in the list and opening that row produced a tab for
 * a session the server no longer had. And once the list did start updating, deleting the LAST row
 * crashed the application with `Stale read from <Show>`, because the memos feeding it were created
 * inside a `<Show>` callback that dies in the same tick.
 *
 * ⚠ THE SECOND SESSION IS DELETED TOO, DELIBERATELY. Emptying the list is the case that crashed;
 * stopping at one deletion would assert the sync and miss the crash entirely.
 */
test("drops a deleted session from the sidebar and survives emptying the list", async ({ page }) => {
  const sessions = fixture.sessions.map((session) => ({ ...session }))
  await mockOpenCodeServer(page, {
    protocol: "v1",
    sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
  })
  await page.addInitScript((directory) => {
    localStorage.setItem(
      "jollicode.global.dat:server",
      JSON.stringify({
        projects: { local: [{ worktree: directory, expanded: true }] },
        lastProject: { local: directory },
      }),
    )
  }, fixture.directory)

  await page.goto("/")
  await openSidebarSession(page, { id: fixture.targetID })

  const rows = page.locator(SIDEBAR_SESSION_ROW)
  const before = await rows.count()
  expect(before).toBeGreaterThan(0)

  // ⚠ SCOPED TO `main`: the project row in the sidebar carries a "More options" of its own.
  const deleteOpenSession = async () => {
    await page.locator("main").getByRole("button", { name: "More options" }).click()
    await page.getByRole("menuitem", { name: "Delete", exact: false }).click()
    await page.getByRole("button", { name: "Delete session", exact: true }).click()
  }

  await deleteOpenSession()
  await expect(sidebarSession(page, { id: fixture.targetID })).toBeHidden()
  await expect(rows).toHaveCount(before - 1)

  // Empty the list: this is what threw `Stale read from <Show>`.
  for (let remaining = before - 1; remaining > 0; remaining--) {
    await rows.first().click()
    await deleteOpenSession()
    await expect(rows).toHaveCount(remaining - 1)
  }

  // The renderer is still the application, not the error page.
  await expect(page.getByText("Something went wrong")).toBeHidden()
  await expect(page.getByRole("button", { name: "New session" }).first()).toBeVisible()
})
