import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible, expectSessionTitle } from "../utils/waits"

/**
 * A DEAD SESSION IS ONLY AN ERROR WHEN THE USER ASKED FOR THAT SESSION.
 *
 * ⚠ THE TWO CASES ARE TOLD APART BY THE TAB STORE, NOT BY THE ERROR. Both reach the same
 * `SessionNotFoundError` through the route lineage. An open tab is where the user happened to be,
 * not a request, so it quietly becomes a new chat; a URL opened straight to a session has no tab of
 * its own and still reports the miss. Assert both, or the recovery silently swallows the deep link
 * case too and a pasted link to a deleted session looks like it worked.
 */

const directory = "C:/OpenCode/StaleSessionTab"
const projectID = "proj_stale_session_tab"
const sessionID = "ses_stale_tab"
const missingID = "ses_never_existed"
const title = "Session that goes away"

type EventPayload = { directory: string; payload: Record<string, unknown> }

test.use({ viewport: { width: 1440, height: 900 } })

test("turns an open tab into a new chat when its session is deleted", async ({ page }) => {
  const events: EventPayload[] = []
  await setup(page, { tabs: [sessionID], events: () => events.splice(0, 1) })

  await page.goto(sessionHref(sessionID))
  await expectSessionTitle(page, title)

  events.push({ directory, payload: { type: "session.deleted", properties: { info: session() } } })

  await expect(page).toHaveURL(/\/new-session\?draftId=/, { timeout: 15_000 })
  await expectAppVisible(page.locator('[data-component="prompt-input"]'))
  await expect(page.getByText("This session cannot be found")).toBeHidden()
})

test("reports the miss for a session opened straight by URL", async ({ page }) => {
  await setup(page, { tabs: [] })

  await page.goto(sessionHref(missingID))

  await expectAppVisible(page.getByText("This session cannot be found"))
  await expect(page.getByRole("button", { name: "Close Tab", exact: true })).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/session/${missingID}$`))
})

async function setup(page: Page, options: { tabs: string[]; events?: () => EventPayload[] }) {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "stale-session-tab",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
    events: options.events,
    eventRetry: options.events ? 16 : undefined,
  })
  await page.addInitScript(
    ({ directory, server, tabs }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "jollicode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "jollicode.window.browser.dat:tabs",
        JSON.stringify(tabs.map((sessionId) => ({ type: "session", server, sessionId }))),
      )
    },
    { directory, server: serverKey(), tabs: options.tabs },
  )
}

function session() {
  return {
    id: sessionID,
    slug: sessionID,
    projectID,
    directory,
    title,
    version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 },
  }
}

function serverKey() {
  return `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
}

function sessionHref(id: string) {
  return `/server/${base64Encode(serverKey())}/session/${id}`
}
