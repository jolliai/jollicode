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

import { createEffect, onCleanup } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { refusalCodeOf } from "@opencode-ai/core/jolli/refusal"
import { catalogGeneration, catalogRefreshed, ensureCatalog, refreshCatalog } from "./catalog"
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
    const count = catalogGeneration()
    void ensureCatalog(`${server.url}#${count}`, () =>
      server.client.jolli
        .course(catalogRefreshed(count) ? { fresh: true } : undefined)
        .then((response) => response.data as Catalog),
    )
  })
}

/**
 * ASK FOR THE CATALOGUE AGAIN WHEN THE GATEWAY REFUSES A TURN, AS A REFUSED START DOES.
 *
 * ⚠ THE SIDECAR HAS LEARNED SOMETHING THIS SCREEN HAS NOT. It records a closure and serves that
 * assistant closed from then on, but the copy held here was fetched before; without asking again the
 * next new chat is offered the same assistant and refused the same way.
 *
 * ⚠ ONE REFRESH PER EVENT, HOWEVER MANY LISTEN. `CourseSessionProvider` calls this, and the draft
 * route nests two of them — `DirectoryDataProvider`'s and `DraftProviders`' — under one server SDK.
 * Unlike the fetch above a refresh is not de-duplicated, so each would ask the gateway again; the
 * SDK hands every listener the same event object, which is what marks it answered.
 */
export function useRefusalRefresh() {
  const serverSDK = useServerSDK()
  const stop = serverSDK().event.listen((e) => {
    const event = e.details
    if (event.type !== "session.error" || event.properties.error?.name !== "APIError") return
    if (answered.has(event)) return
    answered.add(event)
    if (refusalCodeOf(event.properties.error.data.responseBody)) refreshCatalog()
  })
  onCleanup(stop)
}

/** Events {@link useRefusalRefresh} has already looked at. */
const answered = new WeakSet<object>()
