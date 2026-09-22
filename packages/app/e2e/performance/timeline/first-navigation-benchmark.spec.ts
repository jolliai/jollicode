import { openSidebarSession } from "../../utils/nav"
import { expectSessionTitle } from "../../utils/waits"
import { benchmark, expect } from "../benchmark"
import { measureFirstNavigation } from "./first-navigation-probe"
import { fixture } from "./session-timeline-stress.fixture"
import {
  installStressSessionTabs,
  installTimelineSettings,
  mockStressTimeline,
  stressDraftHref,
  stressSessionHref,
} from "./timeline-test-helpers"
import { waitForStableTimeline } from "./session-tab-switch-probe"

const contentSelector = '[data-message-id], [data-component="prompt-input"]'
const draftID = "draft_first_navigation"

benchmark.describe("performance: first navigation paint", () => {
  benchmark("opens an unvisited session tab without a blank frame", async ({ page, report }) => {
    await setup(page)
    const href = stressSessionHref(fixture.targetID)
    const result = await measureFirstNavigation(page, {
      href,
      destinationPath: href,
      sourceSelector: messageSelector(fixture.expected.sourceMessageIDs.at(-1)!),
      destinationSelector: messageSelector(fixture.expected.targetMessageIDs.at(-1)!),
      contentSelector,
      navigate: async () => {
        await openSidebarSession(page, { id: fixture.targetID })
        await expectSessionTitle(page, fixture.expected.targetTitle)
      },
    })
    report(result)
    expect(result.summary.blankSamples).toBe(0)
    expect(result.summary.unknownSamples).toBe(0)
  })

  benchmark("opens the new session page before its lazy module is used", async ({ page, report }) => {
    await setup(page, draftID)
    const href = stressDraftHref(draftID)
    const result = await measureFirstNavigation(page, {
      href,
      destinationPath: href,
      sourceSelector: messageSelector(fixture.expected.sourceMessageIDs.at(-1)!),
      destinationSelector: '[data-component="prompt-input"]',
      contentSelector,
      navigate: async () => {
        /**
         * ⚠ STILL A URL NAVIGATION, BECAUSE A DRAFT HAS NO ROW TO CLICK. The sidebar lists
         * sessions; drafts live in the same registry (`context/tabs.tsx`) but nothing renders them,
         * so the tab strip was the only way back to one. Going through the address the strip's link
         * carried keeps this benchmark measuring what it always measured — first paint of the
         * composer — rather than a navigation path the product no longer has.
         */
        await page.goto(href)
        await expect(page.locator('[data-component="prompt-input"]')).toBeVisible()
      },
    })
    report(result)
    expect(result.summary.blankSamples).toBe(0)
    expect(result.summary.unknownSamples).toBe(0)
  })

  benchmark("opens a child session without a blank frame", async ({ page, report }) => {
    await setup(page)
    const href = stressSessionHref(fixture.childID)
    const result = await measureFirstNavigation(page, {
      href,
      destinationPath: href,
      sourceSelector: messageSelector(fixture.expected.sourceMessageIDs.at(-1)!),
      destinationSelector: messageSelector(fixture.expected.childMessageIDs.at(-1)!),
      contentSelector,
      navigate: async () => {
        await page.locator(`a[href="${href}"]`, { has: page.locator('[data-component="task-tool-card"]') }).click()
        await expectSessionTitle(page, fixture.expected.childTitle)
      },
    })
    report(result)
    expect(result.summary.blankSamples).toBe(0)
    expect(result.summary.unknownSamples).toBe(0)
  })
})

async function setup(page: Parameters<typeof mockStressTimeline>[0], draft?: string) {
  await mockStressTimeline(page)
  await installTimelineSettings(page)
  await installStressSessionTabs(page, draft ? { draftID: draft } : undefined)
  await page.goto(stressSessionHref(fixture.sourceID))
  await expectSessionTitle(page, fixture.expected.sourceTitle)
  await waitForStableTimeline(page, fixture.expected.sourceMessageIDs.at(-1)!)
}

function messageSelector(id: string) {
  return `[data-message-id="${id}"]`
}
