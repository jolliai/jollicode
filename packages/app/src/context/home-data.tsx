/**
 * THE COURSE / SESSION / PROJECT NAVIGATION MODEL, FOR THE WHOLE APPLICATION.
 *
 * ⚠ THE `createHome*` CONTROLLERS USED TO BE INSTANTIATED INSIDE THE HOME PAGE, AND THAT IS WHY THEY
 * ARE STILL NAMED THAT WAY. They stopped being the home page's private business when the sidebar
 * became permanent: it shows the same three lists on every route, so the state behind them has to
 * outlive `/`. Renaming four controllers and their types would be a large diff that says nothing —
 * the names are wrong by history rather than by intent.
 *
 * ⚠ ONE PROVIDER RATHER THAN A SECOND SET OF CONTROLLERS IN THE SIDEBAR. Each of these owns
 * something that must not exist twice: `createHomeProjectsController` holds a
 * `Persist.global("home.servers")` store and a `useServerManagementController`, and
 * `createHomeSessionsController` holds the `session.list` query observer and a prefetch effect. Two
 * copies would race on one storage key, disagree about the focused server, and run the prefetch
 * twice. Sharing them also means the course filter and the project selection are the same in the
 * sidebar and on `/` with no wiring at all.
 *
 * ⚠ `createHomeScrollController` IS DELIBERATELY NOT HERE. It measures the home page's own geometry —
 * it reads `getComputedStyle(header).top` to find the sticky offset and caches each group header's
 * `offsetTop` — which is meaningless for a 300px sidebar. Whoever renders a scrolling list makes
 * their own.
 */

import { createSimpleContext } from "@opencode-ai/ui/context"
import { useJolliCatalog } from "@/jolli/catalog-fetch"
import { createHomeController } from "@/pages/home/home-controller"
import { createHomeProjectsController } from "@/pages/home/home-projects-controller"
import { createHomeSessionSearchController } from "@/pages/home/home-session-search-controller"
import { createHomeSessionsController } from "@/pages/home/home-sessions-controller"

export const { use: useHomeData, provider: HomeDataProvider } = createSimpleContext({
  name: "HomeData",
  /**
   * ⚠ `false`, LIKE THE OTHER SHELL CONTEXTS. Gating would hold every child back until these four
   * settle, and on a session route that is the entire application. The controllers already expose
   * their own loading state to the two or three places that care.
   */
  gate: false,
  init: () => {
    /**
     * ⚠ ASKED FOR HERE SO IT IS ASKED FOR ONCE, ON EVERY ROUTE. The Courses section renders in the
     * sidebar now, which is always mounted, so the catalogue can no longer be the private business
     * of the two routes that happen to sit under `CourseSessionProvider`. See `catalog-fetch.ts`
     * for the bug that taught us this.
     */
    useJolliCatalog()

    const home = createHomeController()
    const projects = createHomeProjectsController(home)
    const sessions = createHomeSessionsController(home)
    const search = createHomeSessionSearchController(home, sessions)
    return { home, projects, sessions, search }
  },
})
