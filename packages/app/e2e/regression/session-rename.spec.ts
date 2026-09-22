import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { openSidebarSession, openSidebarSessionMenu, sidebarSession, sidebarSessionRenameInput } from "../utils/nav"

/**
 * WHY A RENAME IS ONLY ASSERTED AFTER A RELOAD HERE.
 *
 * ⚠ IT IS THE MOCK'S LIMIT, NOT THE PRODUCT'S. A rename is a PATCH, and what puts the new title in
 * front of every other reader is the `session.updated` the server then broadcasts — `server-sync`
 * feeds it to both the session store and the home session index the sidebar reads. This mock's
 * `/event` stream is a fixed list serialised once and closed, so it can acknowledge the PATCH but
 * can never push the event that follows it.
 *
 * ⚠ AND THE OLD SPEC DID NOT NOTICE, because the tab strip it asserted against read the session
 * store directly — the same store the heading writes. The sidebar reads the home index, which is a
 * different cache with a different feed, so the gap this mock has always had is now visible.
 * Reloading refetches both, which is what these assertions stand on.
 */

test.beforeEach(async ({ page }) => {
  const sessions = fixture.sessions.map((session) => ({ ...session }))
  await mockOpenCodeServer(page, {
    protocol: "v1",
    sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
  })
  await page.route(/\/session\/[^/]+(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback()
    const id = new URL(route.request().url()).pathname.split("/").at(-1)
    const session = sessions.find((item) => item.id === id)
    const payload: unknown = route.request().postDataJSON()
    if (
      !session ||
      !payload ||
      typeof payload !== "object" ||
      !("title" in payload) ||
      typeof payload.title !== "string"
    )
      throw new Error("Invalid rename request")
    session.title = payload.title
    await route.fulfill({ json: session, headers: { "access-control-allow-origin": "*" } })
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
  await expect(page.getByRole("heading", { name: fixture.expected.targetTitle, exact: true })).toBeVisible()
})

for (const commit of ["Enter", "blur", "click outside"]) {
  test(`saves the session heading on ${commit}`, async ({ page }) => {
    await page.getByRole("heading", { name: fixture.expected.targetTitle, exact: true }).click()
    const input = page.locator('input[data-slot="session-title-child"]')
    await expect(input).toBeFocused()
    await input.fill("Renamed session")
    if (commit === "Enter") await input.press("Enter")
    if (commit === "blur") await input.press("Tab")
    if (commit === "click outside") await page.getByRole("textbox", { name: "Prompt", exact: true }).click()
    await expect(page.getByRole("heading", { name: "Renamed session", exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByRole("heading", { name: "Renamed session", exact: true })).toBeVisible()
    // ⚠ AFTER THE RELOAD, NOT BEFORE — see the note at the top of this file. The row is addressed
    // by id rather than by the text this line is about to assert.
    await expect(sidebarSession(page, { id: fixture.targetID })).toContainText("Renamed session")
  })
}

test("cancels the session heading with Escape", async ({ page }) => {
  await page.getByRole("heading", { name: fixture.expected.targetTitle, exact: true }).click()
  const input = page.locator('input[data-slot="session-title-child"]')
  await input.fill("Discard this title")
  await input.press("Escape")
  await expect(page.getByRole("heading", { name: fixture.expected.targetTitle, exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole("heading", { name: fixture.expected.targetTitle, exact: true })).toBeVisible()
})

test("keeps the draft when saving the session heading fails", async ({ page }) => {
  await page.route(/\/session\/[^/]+(?:\?.*)?$/, (route) => {
    if (route.request().method() !== "PATCH") return route.fallback()
    return route.fulfill({ status: 500, headers: { "access-control-allow-origin": "*" } })
  })
  await page.getByRole("heading", { name: fixture.expected.targetTitle, exact: true }).click()
  const input = page.locator('input[data-slot="session-title-child"]')
  await input.fill("Retry this title")
  await input.press("Tab")
  await expect(page.getByText("Request failed", { exact: true })).toBeVisible()
  await expect(input).toBeEnabled()
  await expect(input).toHaveValue("Retry this title")
  await expect(sidebarSession(page, { id: fixture.targetID })).toContainText(fixture.expected.targetTitle)
})

test("does not save an empty session heading", async ({ page }) => {
  await page.getByRole("heading", { name: fixture.expected.targetTitle, exact: true }).click()
  const input = page.locator('input[data-slot="session-title-child"]')
  await input.fill("   ")
  await input.press("Tab")
  await expect(page.getByRole("heading", { name: fixture.expected.targetTitle, exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole("heading", { name: fixture.expected.targetTitle, exact: true })).toBeVisible()
})

/**
 * ⚠ THIS USED TO BE THE TAB STRIP'S CONTEXT MENU, AND THE SIDEBAR ROW'S IS ITS SUCCESSOR, NOT A
 * RENAMED SELECTOR. Two things genuinely changed with it. The editor commits on Enter and DISCARDS
 * on blur — `createInlineEditorController`, which the strip did not use — so the old `press("Tab")`
 * would now throw the rename away. And "Close tab" no longer removes anything from this list: the
 * row is the session, not a registry entry, so closing navigates off it and leaves it listed.
 */
test("renames and closes the session from its sidebar row menu", async ({ page }) => {
  const row = await openSidebarSessionMenu(page, { id: fixture.targetID })
  await expect(page.getByRole("menuitem", { name: "Rename", exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("menuitem", { name: "Rename", exact: true })).toBeHidden()

  // ⚠ THE KEYBOARD PATH IS THE POINT OF THIS SECOND OPEN. A menu reachable only by right-click is a
  // menu that does not exist for anyone who does not use a mouse.
  await row.focus()
  await row.press("Shift+F10")
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click()
  const input = sidebarSessionRenameInput(page)
  await expect(input).toBeFocused()
  await input.fill("Renamed from row")
  await input.press("Enter")
  await expect(input).toBeHidden()
  await page.reload()
  await expect(page.getByRole("heading", { name: "Renamed from row", exact: true })).toBeVisible()

  await openSidebarSessionMenu(page, { id: fixture.targetID })
  await page.getByRole("menuitem", { name: "Close tab", exact: true }).click()
  // Closing leaves the session alone — it is still listed, it is just no longer the one on screen.
  await expect(page).not.toHaveURL(new RegExp(`/session/${fixture.targetID}$`))
  await expect(sidebarSession(page, { id: fixture.targetID })).toBeVisible()
  await expect(sidebarSession(page, { id: fixture.targetID })).toContainText("Renamed from row")
  await expect(sidebarSession(page, { id: fixture.targetID })).not.toHaveAttribute("data-selected", "")
})

test("renames a session that is not the one on screen", async ({ page }) => {
  await openSidebarSession(page, { id: fixture.sourceID })
  await expect(page.getByRole("heading", { name: fixture.expected.sourceTitle, exact: true })).toBeVisible()

  await openSidebarSessionMenu(page, { id: fixture.targetID })
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click()
  const input = sidebarSessionRenameInput(page)
  await expect(input).toBeFocused()
  await input.fill("Row renamed in place")
  await input.press("Enter")
  await expect(input).toBeHidden()

  // ⚠ THE POINT OF THE TEST: renaming a row you are not standing in does not move you to it.
  await expect(page.getByRole("heading", { name: fixture.expected.sourceTitle, exact: true })).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/session/${fixture.sourceID}$`))

  await page.reload()
  await expect(page).toHaveURL(new RegExp(`/session/${fixture.sourceID}$`))
  await openSidebarSession(page, { id: fixture.targetID })
  await expect(page.getByRole("heading", { name: "Row renamed in place", exact: true })).toBeVisible()
})

/**
 * ⚠ BLUR DISCARDS, WHICH IS THE ONE BEHAVIOUR THE STRIP'S EDITOR DID NOT SHARE. Worth pinning
 * rather than only noting: it is the difference between "Tab commits" and "Tab throws away", and
 * the spec above would have silently kept passing on the old meaning.
 */
test("discards a row rename on blur", async ({ page }) => {
  await openSidebarSessionMenu(page, { id: fixture.targetID })
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click()
  const input = sidebarSessionRenameInput(page)
  await expect(input).toBeFocused()
  await input.fill("Never committed")
  await input.blur()
  await expect(input).toBeHidden()
  await expect(sidebarSession(page, { id: fixture.targetID })).toContainText(fixture.expected.targetTitle)
  await page.reload()
  await expect(page.getByRole("heading", { name: fixture.expected.targetTitle, exact: true })).toBeVisible()
})
