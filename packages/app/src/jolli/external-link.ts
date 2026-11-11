import { Option } from "effect"

/**
 * Keep every link inside shared or untrusted content from leaving the app on its own. A click, a
 * modified click or a middle click on a link never follows it: an `http(s)` address goes to `open`,
 * which must ask the person first, a link to a place in the same content scrolls there within `root`
 * (or goes to `fragment`, for content that finds its own places), and anything else does nothing.
 *
 * ⚠ The desktop shell opens any address a window navigates to, or opens a new window for, in the
 * browser without asking, so a link left to its default action is a link opened unseen. Middle and
 * modified clicks are new-window requests, which is why `auxclick` is caught as well as `click`.
 *
 * Listens in the capture phase on `root`, which may be another document (a sandboxed frame's).
 * Returns the remover.
 */
export function guardExternalLinks(
  root: HTMLElement | Document,
  handlers: { open: (url: string) => void; fragment?: (id: string) => void },
) {
  const follow = (event: Event) => {
    // A right click's auxclick only opens the context menu, which offers no way to follow the link.
    if (event.type === "auxclick" && (!("button" in event) || event.button !== 1)) return
    const anchor = isElement(event.target) ? event.target.closest("a[href]") : null
    if (!anchor) return
    event.preventDefault()
    event.stopPropagation()
    const href = anchor.getAttribute("href") ?? ""
    if (href.startsWith("#") && handlers.fragment) {
      handlers.fragment(href.slice(1))
      return
    }
    if (href.startsWith("#")) {
      fragmentTarget(root, href.slice(1))?.scrollIntoView()
      return
    }
    const url = URL.canParse(href, anchor.baseURI) ? safeReferenceUrl(new URL(href, anchor.baseURI).href) : undefined
    if (url) handlers.open(url)
  }
  root.addEventListener("click", follow, true)
  root.addEventListener("auxclick", follow, true)
  return () => {
    root.removeEventListener("click", follow, true)
    root.removeEventListener("auxclick", follow, true)
  }
}

/**
 * The element a link to `fragment` points at inside `root`, found the way a browser finds it: by id,
 * else by an anchor's name, as written or percent-decoded. Never outside `root`, so a link in shared
 * content cannot move the page around it.
 */
function fragmentTarget(root: HTMLElement | Document, fragment: string) {
  if (!fragment) return undefined
  const names = new Set([
    fragment,
    Option.getOrElse(Option.liftThrowable(decodeURIComponent)(fragment), () => fragment),
  ])
  const elements = Array.from(root.querySelectorAll("[id], a[name]"))
  return (
    elements.find((element) => names.has(element.getAttribute("id") ?? "")) ??
    elements.find((element) => element.localName === "a" && names.has(element.getAttribute("name") ?? ""))
  )
}

/** An address shared content may load or open: only `http(s)`, and nothing for anything else. */
export function safeReferenceUrl(value: string | undefined) {
  if (!value || !URL.canParse(value)) return undefined
  const url = new URL(value)
  return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined
}

/**
 * By node type rather than `instanceof` any window's `Element`: docx-preview builds a Word document's
 * nodes with the parent window's `document` and moves them into its frame, and a moved node keeps the
 * prototypes of the window that made it, so neither window's `Element` reliably recognises it.
 */
function isElement(target: EventTarget | null): target is Element {
  return target !== null && "nodeType" in target && target.nodeType === Node.ELEMENT_NODE
}
