import DOMPurify from "dompurify"

const config = {
  USE_PROFILES: { html: true, mathMl: true },
  SANITIZE_NAMED_PROPS: true,
  FORBID_TAGS: ["style"],
  FORBID_CONTENTS: ["style", "script"],
  ADD_TAGS: ["svg", "path"],
  ADD_ATTR: ["d", "viewBox", "preserveAspectRatio", "xmlns", "target"],
}

if (typeof window !== "undefined" && DOMPurify.isSupported) {
  DOMPurify.addHook("afterSanitizeAttributes", (node: Element) => {
    if (!(node instanceof HTMLAnchorElement)) return
    if (node.target !== "_blank") return

    const rel = node.getAttribute("rel") ?? ""
    const set = new Set(rel.split(/\s+/).filter(Boolean))
    set.add("noopener")
    set.add("noreferrer")
    node.setAttribute("rel", Array.from(set).join(" "))
  })
}

/**
 * Every class KaTeX's stylesheet styles (katex 0.16). Its rules all sit under `.katex`, so a sender who
 * uses these gains typesetting and nothing of the app's own look.
 */
const katexClasses = new Set(
  `
  accent accent-body accent-full amsrm angl anglpad arraycolsep base boldsymbol boxpad brace-center brace-left
  brace-right cancel-lap cancel-pad cd-arrow-pad cd-label-left cd-label-right cd-vert-arrow clap col-align-c
  col-align-l col-align-r com delim-size1 delim-size4 delimcenter delimsizing eqn-num fbox fcolorbox fix fleqn
  fontsize-ensurer frac-line halfarrow-left halfarrow-right hbox hdashline hide-tail hline inner katex
  katex-display katex-html katex-mathml katex-version large-op leqno llap mainrm mathbb mathbf mathboldfrak
  mathboldsf mathcal mathfrak mathit mathitsf mathnormal mathrm mathscr mathsf mathsfit mathtt mfrac mml-eqn-num
  mover mspace msupsub mtable mtr-glue mult munder newline nulldelimiter op-limits op-symbol overlay overline
  overline-line pstrut reset-size1 reset-size10 reset-size11 reset-size2 reset-size3 reset-size4 reset-size5
  reset-size6 reset-size7 reset-size8 reset-size9 rlap root rule size1 size10 size11 size2 size3 size4 size5 size6
  size7 size8 size9 sizing small-op sout sqrt stretchy strut svg-align tag textbb textbf textboldfrak textboldsf
  textfrak textit textitsf textrm textscr textsf texttt thinbox underline underline-line vbox vertical-separator
  vlist vlist-r vlist-s vlist-t vlist-t2 x-arrow x-arrow-pad
`
    .trim()
    .split(/\s+/),
)

export function sanitizeMarkdown(html: string, untrusted = false) {
  if (!DOMPurify.isSupported) return ""
  if (!untrusted) return DOMPurify.sanitize(html, config)
  const escape = (text: string) =>
    text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  const decode = (text: string) => {
    const element = document.createElement("textarea")
    element.innerHTML = text
    return element.value
  }
  const linked = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const attribute = (name: string) =>
      new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i")
        .exec(tag)
        ?.slice(1)
        .find((value) => value !== undefined)
    const src = attribute("src")
    if (!src || !/^https?:\/\//i.test(src)) return ""
    // The address stays readable in the text: alt text alone could pass off one site as another.
    const href = decode(src)
    const alt = decode(attribute("alt") ?? "").trim()
    const label = alt && alt !== href ? `${alt} (${href})` : href
    return `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${escape(label)}</a>`
  })
  const forbiddenAttributes = [
    "style",
    "src",
    "srcset",
    "poster",
    "background",
    "ping",
    "action",
    "formaction",
    "xlink:href",
  ]
  const forbiddenTags = [
    ...config.FORBID_TAGS,
    "script",
    "img",
    "picture",
    "video",
    "audio",
    "source",
    "iframe",
    "object",
    "embed",
    "input",
    "link",
    "meta",
    "base",
    "form",
  ]
  // No `data-*` either: the app's own styles and scripts select on them.
  const safe = DOMPurify.sanitize(linked, {
    ...config,
    FORBID_ATTR: forbiddenAttributes,
    FORBID_TAGS: forbiddenTags,
    ALLOW_DATA_ATTR: false,
  })
  // Template contents remain inert while the final resource and navigation boundary is checked.
  const template = document.createElement("template")
  template.innerHTML = safe
  for (const node of Array.from(template.content.querySelectorAll("*"))) {
    if (forbiddenTags.includes(node.localName)) {
      node.remove()
      continue
    }
    for (const attribute of node.getAttributeNames())
      if (forbiddenAttributes.includes(attribute.toLowerCase()) || attribute.toLowerCase().startsWith("on"))
        node.removeAttribute(attribute)
    // A sender's classes would dress their HTML in the app's own styles, as a full-screen overlay or a
    // message from someone else. Only the classes rendering reads survive: a code block's language,
    // the mark of a link the parser made, and KaTeX's own.
    const kept = Array.from(node.classList).filter(
      (name) =>
        katexClasses.has(name) ||
        (node.localName === "code" && name.startsWith("language-")) ||
        (node.localName === "a" && name === "external-link"),
    )
    node.removeAttribute("class")
    if (kept.length) node.setAttribute("class", kept.join(" "))
    const href = node.getAttribute("href")
    if (
      href &&
      (!URL.canParse(href, window.location.href) ||
        !["http:", "https:"].includes(new URL(href, window.location.href).protocol))
    )
      node.removeAttribute("href")
  }
  return template.innerHTML
}
