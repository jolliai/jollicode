/**
 * A CLOCK THAT TICKS ONLY WHEN AN ASSISTANT'S AVAILABILITY WINDOW OPENS OR CLOSES.
 *
 * ⚠ ONE WAIT, ARMED FOR THE NEXT BOUNDARY AND RE-ARMED AFTER EACH TICK, rather than an interval that
 * moves the signal. Nothing on screen depends on the time except which assistants may start, and that
 * changes only at a boundary — so a student whose agent closes at 23:59 sees the picker change at
 * 23:59 without the app re-rendering every second in between. `Lookup.nextWindowBoundaryAt` decides
 * the instant, `Lookup.watchBoundary` keeps the wait honest across sleep.
 *
 * ⚠ RE-ARMED WHEN THE CATALOGUE CHANGES TOO, because a refresh can bring a window that was not
 * there when the wait was set.
 */

import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"
import { Lookup } from "@opencode-ai/core/jolli/lookup"
import type { Assistant } from "./types"

export function createWindowClock(assistants: Accessor<readonly Assistant[]>): Accessor<Date> {
  const [now, setNow] = createSignal(new Date())
  /**
   * ⚠ A NEW CATALOGUE RESETS THE CLOCK BEFORE THE WAIT IS ARMED FROM IT. `now` holds the time of the
   * last tick, which can be minutes old; arming from it put the next boundary that much too late —
   * an agent closed at 10:35:45 showed as closed only at 10:36:17, 76 seconds after the clock was
   * last set. Resetting also settles a boundary the new catalogue brings that has already passed.
   */
  createEffect(on(assistants, () => setNow(new Date()), { defer: true }))
  createEffect(() => {
    const due = Lookup.nextWindowBoundaryAt(assistants(), now())
    if (due === undefined) return
    onCleanup(Lookup.watchBoundary(due, () => setNow(new Date())))
  })
  return now
}
