import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { createGroupChatFollow } from "./group-chat-follow"

/** A follow whose reads and watches are counted; a watch it asks for goes out as the page's would. */
function counted() {
  const asked = { reads: 0, watches: 0 }
  const follow = createGroupChatFollow({
    read: () => asked.reads++,
    watch: () => {
      asked.watches++
      follow.watching()
    },
  })
  return { follow, asked }
}

describe("an open chat page reading and following its chat again on its own", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  test("a read turned away for now is read again, sooner at first", () => {
    const page = counted()
    page.follow.read({ reached: false })
    jest.advanceTimersByTime(1_999)
    expect(page.asked.reads).toBe(0)
    jest.advanceTimersByTime(1)
    expect(page.asked.reads).toBe(1)
    page.follow.read({ reached: false })
    jest.advanceTimersByTime(3_999)
    expect(page.asked.reads).toBe(1)
    jest.advanceTimersByTime(1)
    expect(page.asked.reads).toBe(2)
    page.follow.read({ reached: true })
    jest.advanceTimersByTime(120_000)
    expect(page.asked.reads).toBe(2)
  })

  test("a first watch that failed is asked again with the read, even though the read got through", () => {
    const page = counted()
    page.follow.read({ reached: true })
    page.follow.watching()
    page.follow.watched({ ok: false })
    jest.advanceTimersByTime(2_000)
    expect(page.asked).toEqual({ reads: 1, watches: 1 })
    // The read answers before the watch does: the wait is neither reset nor started again.
    page.follow.read({ reached: true })
    page.follow.watched({ ok: true })
    jest.advanceTimersByTime(120_000)
    expect(page.asked).toEqual({ reads: 1, watches: 1 })
  })

  test("a watch that keeps failing backs off while reads keep getting through", () => {
    const page = counted()
    page.follow.read({ reached: true })
    page.follow.watching()
    const waits: number[] = []
    for (let round = 0; round < 4; round++) {
      page.follow.watched({ ok: false })
      const before = page.asked.watches
      let waited = 0
      while (page.asked.watches === before) {
        jest.advanceTimersByTime(1_000)
        waited += 1_000
      }
      waits.push(waited)
      page.follow.read({ reached: true })
    }
    expect(waits).toEqual([2_000, 4_000, 8_000, 16_000])
  })

  test("a read and a watch that both failed are asked again together, once each", () => {
    const page = counted()
    page.follow.read({ reached: false })
    page.follow.watching()
    page.follow.watched({ ok: false })
    jest.advanceTimersByTime(60_000)
    expect(page.asked.watches).toBe(1)
    expect(page.asked.reads).toBe(1)
  })

  test("a page that dropped its chat asks nothing more until it starts over", () => {
    const page = counted()
    page.follow.read({ reached: false })
    page.follow.stop()
    page.follow.watched({ ok: false })
    page.follow.read({ reached: false })
    jest.advanceTimersByTime(120_000)
    expect(page.asked).toEqual({ reads: 0, watches: 0 })
    page.follow.reset()
    page.follow.read({ reached: false })
    jest.advanceTimersByTime(2_000)
    expect(page.asked).toEqual({ reads: 1, watches: 0 })
  })

  test("a hidden page waits to be shown instead of reading", () => {
    const page = counted()
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" })
    try {
      page.follow.read({ reached: false })
      jest.advanceTimersByTime(2_000)
      expect(page.asked.reads).toBe(0)
    } finally {
      // Back to the document's own getter.
      Reflect.deleteProperty(document, "visibilityState")
    }
  })
})
