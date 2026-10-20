import { beforeAll, expect, mock, test } from "bun:test"
import { createComponent, getOwner, runWithOwner, type Owner } from "solid-js"
import { render } from "solid-js/web"

/** The owner the projects controller was made under: the one `useDialog` would mount its dialogs under. */
const made: { owner?: Owner | null; count: number } = { count: 0 }

/**
 * ⚠ MODULE MOCKS OUTLIVE THE FILE, SO EVERY ONE HERE IS NARROW. The provider and the context are the real
 * ones; the four controllers stand in for the routes, servers and queries this test has no use for, and
 * nothing else here imports them. The catalogue fetch is mocked as `session-binding.test.ts` mocks it.
 */
beforeAll(() => {
  mock.module("@/jolli/catalog-fetch", () => ({ useJolliCatalog: () => undefined, useRefusalRefresh: () => undefined }))
  mock.module("@/pages/home/home-controller", () => ({ createHomeController: () => ({ name: "home" }) }))
  mock.module("@/pages/home/home-projects-controller", () => ({
    createHomeProjectsController: () => {
      made.owner = getOwner()
      made.count++
      return { name: "projects" }
    },
  }))
  mock.module("@/pages/home/home-sessions-controller", () => ({
    createHomeSessionsController: () => ({ name: "sessions" }),
  }))
  mock.module("@/pages/home/home-session-search-controller", () => ({
    createHomeSessionSearchController: () => ({ name: "search" }),
  }))
})

/**
 * ⚠ A DIALOG A CONTROLLER OPENS, AND EVERY DIALOG SHOWN OVER IT, IS MOUNTED UNDER THE OWNER THE CONTROLLER
 * WAS MADE UNDER. That owner must see the context, or a dialog shown over "Add project" that reads
 * `useHomeData()` throws and the app goes to its error page.
 */
test("the controllers are made under an owner that sees the home data they fill", async () => {
  const { HomeDataProvider, useHomeData } = await import("@/context/home-data")
  const seen: { child?: ReturnType<typeof useHomeData> } = {}
  const root = document.createElement("div")
  const dispose = render(
    () =>
      createComponent(HomeDataProvider, {
        get children() {
          seen.child = useHomeData()
          return undefined
        },
      }),
    root,
  )
  try {
    expect(made.count).toBe(1)
    expect(made.owner).toBeTruthy()
    const fromController = runWithOwner(made.owner!, () => useHomeData())
    expect(fromController).toBe(seen.child)
    expect(fromController).toMatchObject({
      home: { name: "home" },
      projects: { name: "projects" },
      sessions: { name: "sessions" },
      search: { name: "search" },
    })
  } finally {
    dispose()
  }
})
