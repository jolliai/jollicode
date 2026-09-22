/**
 * ASK THE SERVER FOR THIS STUDENT'S COURSES, FROM WHEREVER A SCREEN NEEDS THEM.
 *
 * ⚠ THIS EXISTS BECAUSE THE FETCH USED TO LIVE INSIDE `CourseSessionProvider`, AND THE HOME ROUTE IS
 * NOT UNDER IT. `CourseSessionProvider` mounts in two places — the draft route and the directory
 * layout — and `/` is under neither, so a launch that restored the home screen never asked for the
 * catalogue at all and the Courses section silently rendered nothing. It looked like "this student
 * has no courses", which is a sentence the UI is entitled to say and in that case was false.
 *
 * ⚠ CALLING IT FROM SEVERAL PLACES IS THE POINT, NOT A COMPROMISE. `ensureCatalog` keys in-flight
 * and completed loads by server URL, so the second and third caller cost nothing; that de-duping is
 * exactly why it was written. A hook, rather than a bare function, so each caller's effect is owned
 * by that caller's lifecycle.
 */

import { createEffect } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { catalogGeneration, ensureCatalog } from "./catalog"
import type { Catalog } from "./types"

export function useJolliCatalog() {
  const serverSDK = useServerSDK()
  createEffect(() => {
    const server = serverSDK()
    /**
     * ⚠ THE GENERATION IS READ SO A RESET RE-RUNS THIS. The server's URL survives a sign-in — the
     * sidecar restarts on the same host and port — so it cannot be the only thing this depends on,
     * and `resetCatalog()` would otherwise clear the store with nothing left to refill it.
     */
    void ensureCatalog(`${server.url}#${catalogGeneration()}`, () =>
      server.client.jolli.course().then((response) => response.data as Catalog),
    )
  })
}
