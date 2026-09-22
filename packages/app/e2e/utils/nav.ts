import { expect, type Locator, type Page } from "@playwright/test"

/**
 * HOW A TEST REACHES A SESSION NOW THAT THERE IS NO TAB STRIP.
 *
 * ⚠ THIS EXISTS BECAUSE THE OLD LOCATORS WERE NOT A SELECTOR DETAIL. Sessions used to be
 * `<a href="/server/<key>/session/<id>">` inside `[data-slot="titlebar-tabs"]`, so a spec could
 * point at one by URL and read its title out of the strip. The sidebar renders each session as a
 * `<button>` with no href, which means every one of those locators had to be rewritten rather than
 * renamed — and rewritten the same way in a dozen files, which is what this module is for.
 *
 * ⚠ PREFER `id` OVER `title`. Several specs rename a session while running and then assert on the
 * new name; addressing a row by the text you are about to change is how those tests become flaky.
 * `data-session-id` exists on the row for exactly this reason.
 */
export const SIDEBAR_SESSION_ROW = '[data-component="app-sidebar-session-row"]'

/** The sidebar row for one session, addressed by id (preferred) or by its visible title. */
export function sidebarSession(page: Page, target: { id: string } | { title: string }): Locator {
  if ("id" in target) return page.locator(`${SIDEBAR_SESSION_ROW}[data-session-id="${target.id}"]`)
  return page.locator(SIDEBAR_SESSION_ROW, { hasText: target.title })
}

/**
 * Click through to a session from the sidebar.
 *
 * ⚠ IT WAITS FOR THE ROW FIRST. The list is fed by `session.list` and streams in, so a bare click
 * races the row's arrival — the tab strip had the same property and each spec used to handle it
 * inline, or not at all.
 */
export async function openSidebarSession(page: Page, target: { id: string } | { title: string }) {
  const row = sidebarSession(page, target)
  await expect(row).toBeVisible()
  await row.click()
  return row
}

/**
 * Open a session row's actions, which is where Rename and Close live.
 *
 * ⚠ RIGHT-CLICK, AND THERE IS NO VISIBLE TRIGGER TO CLICK INSTEAD. The row handles `contextmenu` on
 * its wrapper and anchors the popover to a zero-size span — a 300px row has no width to spare for a
 * button — so a spec cannot reach these the way it would reach a menu anywhere else in the app.
 */
export async function openSidebarSessionMenu(page: Page, target: { id: string } | { title: string }) {
  const row = sidebarSession(page, target)
  await expect(row).toBeVisible()
  await row.click({ button: "right" })
  return row
}

/** The rename field a session row turns into, once Rename has been chosen from its menu. */
export function sidebarSessionRenameInput(page: Page): Locator {
  return page.locator(`${SIDEBAR_SESSION_ROW} [data-component="inline-input"]`)
}

/**
 * Whether the sidebar shows this session as the one being viewed.
 *
 * ⚠ THIS IS A DIFFERENT FACT FROM WHAT THE STRIP SHOWED, AND IT IS WHY THE ATTRIBUTE IS NEW. A tab
 * being present meant "open"; `data-selected` means "this is the one on screen". With tabs, those
 * two were the same thing often enough that specs conflated them.
 */
export async function expectSidebarSessionActive(page: Page, target: { id: string } | { title: string }) {
  await expect(sidebarSession(page, target)).toHaveAttribute("data-selected", "")
}

/** The session id out of a `/server/<key>/session/<id>` href, for specs that only kept the URL. */
export function sessionIdFromHref(href: string) {
  const id = href.split("/session/")[1]?.split(/[?#]/)[0]
  if (!id) throw new Error(`Not a session href: ${href}`)
  return id
}
