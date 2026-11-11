import { createEffect, onCleanup } from "solid-js"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import type { GroupChatLocator } from "@/jolli/group-chat-sources"
import { findCitedHeading } from "@/jolli/reference-heading"

/** Apply the web reader's heading locator after Markdown commits its asynchronous blocks. */
export function ReferenceMarkdown(props: { text: string; locator?: GroupChatLocator }) {
  let host: HTMLDivElement | undefined
  createEffect(() => {
    const locator = props.locator
    props.text
    if (!host || locator?.kind !== "heading") return
    const root = host
    const place = () => {
      const heading = findCitedHeading(root, locator.path)
      if (!heading) return
      heading.scrollIntoView({ block: "start" })
      observer.disconnect()
    }
    const observer = new MutationObserver(place)
    observer.observe(root, { childList: true, subtree: true })
    place()
    onCleanup(() => observer.disconnect())
  })
  return (
    <div ref={host}>
      <Markdown text={props.text} untrusted />
    </div>
  )
}
