import { benchmark, expect } from "../benchmark"
import { SIDEBAR_SESSION_ROW, sidebarSession } from "../../utils/nav"
import { expectSessionTitle } from "../../utils/waits"
import { measureNavigationMilestones } from "./navigation-milestones"
import { fixture } from "./session-timeline-stress.fixture"
import {
  createReviewDiffs,
  installStressSessionTabs,
  installTimelineSettings,
  mockStressTimeline,
  stressSessionHref,
} from "./timeline-test-helpers"
import { waitForStableTimeline } from "./session-tab-switch-probe"

/**
 * ⚠ WHAT THIS MEASURES SURVIVED THE TAB STRIP; THE THINGS IT POINTED AT DID NOT. Sessions were
 * reached from a home list (`[data-component="home-session-row"]`) and the arrival was read off a
 * freshly painted tab; both now live in one sidebar row, which is on screen before the navigation
 * starts. So the second milestone is the row becoming SELECTED rather than the row existing — the
 * only part of it that still changes when you navigate.
 */
const sessionRow = SIDEBAR_SESSION_ROW
const homePane = '[data-component="home-empty"]'

/** The row for one session, once it is the one on screen. */
const selectedRow = (sessionID: string) => `${SIDEBAR_SESSION_ROW}[data-session-id="${sessionID}"][data-selected]`

benchmark.describe("performance: sidebar and session navigation", () => {
  benchmark("opens a session from the sidebar and marks its row selected", async ({ page, report }) => {
    await setup(page, [])
    await page.goto("/")
    const row = sidebarSession(page, { id: fixture.targetID })
    await expect(row).toBeVisible()
    const result = await measureNavigationMilestones(page, {
      triggerSelector: sessionRow,
      milestones: {
        content: { selector: messageSelector(fixture.expected.targetMessageIDs.at(-1)!) },
        selected: { selector: selectedRow(fixture.targetID) },
      },
      navigate: async () => {
        await row.click()
        await expectSessionTitle(page, fixture.expected.targetTitle)
      },
    })
    report(result)
    await expect(row).toContainText(fixture.expected.targetTitle)
  })

  /**
   * ⚠ THE REVIEW SIDE OF THIS HAD BEEN MEASURING NOTHING SINCE JUNE, AND NOT BECAUSE OF THE SIDEBAR.
   * The spec was written while the pane defaulted open; `cb3e28d20` ("collapse review pane by
   * default") landed six days later and flipped `DEFAULT_REVIEW_PANEL_OPENED` to `false` without
   * touching it. From then on the panel never mounted, so "did content paint before the review body"
   * was answered `true` by a review body that was never going to exist, and the trailing assertion
   * could not pass. Seeding the panel open with real diffs is what gives the question something to
   * be about.
   *
   * ⚠ THE END-STATE ASSERTION IS THE PANEL, NOT THE DIFF BODY. `session-review` is the body for a
   * SELECTED file; an open panel with no selection shows the changed-file tree and no body. Forcing
   * a file selection here would be measuring the file picker, which is a different benchmark.
   */
  benchmark("stages the review body after cold session content", async ({ page, report }) => {
    // ⚠ DIFFS AND AN OPEN PANEL, BECAUSE THE PANE NEEDS BOTH. `createReviewDiffs` is the same
    // fixture `session-tab-switch-benchmark` feeds its review-pane trials.
    await setup(page, [], { vcsDiff: createReviewDiffs() })
    await page.addInitScript(() => {
      localStorage.setItem(
        "jollicode.global.dat:layout",
        JSON.stringify({ review: { diffStyle: "split", panelOpened: true } }),
      )
    })
    await page.goto("/")
    const row = sidebarSession(page, { id: fixture.targetID })
    await expect(row).toBeVisible()
    const result = await page.evaluate(
      ({ rowSelector, contentSelector }) =>
        new Promise<{ contentBeforeReview: boolean; samples: number }>((resolve) => {
          let samples = 0
          const sample = () => {
            samples++
            const content = !!document.querySelector(contentSelector)
            const review = !!document.querySelector('[data-component="session-review"]')
            if (content && !review) {
              resolve({ contentBeforeReview: true, samples })
              return
            }
            if (content && review) {
              resolve({ contentBeforeReview: false, samples })
              return
            }
            requestAnimationFrame(sample)
          }
          // ⚠ BY ID, NOT BY TITLE. The row carries `data-session-id` precisely so automation does not
          // have to match on text — see `e2e/utils/nav.ts`.
          const target = document.querySelector<HTMLElement>(rowSelector)
          if (!target) throw new Error(`Sidebar session row not found: ${rowSelector}`)
          target.click()
          requestAnimationFrame(sample)
        }),
      {
        rowSelector: `${SIDEBAR_SESSION_ROW}[data-session-id="${fixture.targetID}"]`,
        contentSelector: messageSelector(fixture.expected.targetMessageIDs.at(-1)!),
      },
    )
    report(result)
    expect(result.contentBeforeReview).toBe(true)
    await expect(page.locator("#review-panel")).toBeVisible()
  })

  /**
   * ⚠ "CLOSE" IS REACHED FROM THE ROW'S CONTEXT MENU NOW, AND IT NO LONGER REMOVES A ROW. The strip
   * had a close button per tab and closing took the tab off screen; the sidebar lists sessions, not
   * registry entries, so what actually changes is that the row stops being selected and the route
   * falls back to home. Those two are the milestones.
   *
   * ⚠ THE RIGHT-CLICK DOES NOT START THE CLOCK. The probe arms a one-shot `click` listener, and a
   * secondary-button press does not produce a `click` event — so the timer starts on the menu item,
   * which is the interaction being measured.
   */
  benchmark("closes the only open session and paints home", async ({ page, report }) => {
    await setup(page, [fixture.sourceID])
    await page.goto(stressSessionHref(fixture.sourceID))
    await expectSessionTitle(page, fixture.expected.sourceTitle)
    await waitForStableTimeline(page, fixture.expected.sourceMessageIDs.at(-1)!)
    const row = sidebarSession(page, { id: fixture.sourceID })
    await expect(row).toHaveAttribute("data-selected", "")
    const result = await measureNavigationMilestones(page, {
      triggerSelector: '[data-action="sidebar-session-close"]',
      milestones: {
        home: { selector: homePane },
        deselected: { selector: selectedRow(fixture.sourceID), visible: false },
      },
      navigate: async () => {
        await row.click({ button: "right" })
        await page.getByRole("menuitem", { name: "Close tab", exact: true }).click()
        await expect(page).toHaveURL("/")
      },
    })
    report(result)
  })
})

async function setup(
  page: Parameters<typeof mockStressTimeline>[0],
  sessionIDs: string[],
  input?: Parameters<typeof mockStressTimeline>[1],
) {
  await mockStressTimeline(page, input)
  await installTimelineSettings(page)
  await installStressSessionTabs(page, { sessionIDs })
}

function messageSelector(id: string) {
  return `[data-message-id="${id}"]`
}
