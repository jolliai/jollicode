import { safeReferenceUrl } from "./reference-preview"

/**
 * Keep every link inside shared or untrusted content from leaving the app on its own. A click, a
 * modified click or a middle click on a link never follows it: an `http(s)` address goes to `open`,
 * which must ask the person first, a link to a place in the same document goes to `fragment`, and
 * anything else does nothing.
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
    if (href.startsWith("#")) {
      handlers.fragment?.(href.slice(1))
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
 * By node type rather than `instanceof` any window's `Element`: docx-preview builds a Word document's
 * nodes with the parent window's `document` and moves them into its frame, and a moved node keeps the
 * prototypes of the window that made it, so neither window's `Element` reliably recognises it.
 */
function isElement(target: EventTarget | null): target is Element {
  return target !== null && "nodeType" in target && target.nodeType === Node.ELEMENT_NODE
}
