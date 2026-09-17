import { createUniqueId, type ComponentProps } from "solid-js"
import { JolliLogotypeBody, JolliMarkBody } from "../../components/jolli-brand"

/**
 * THE NEW-SESSION HERO: the Jolli mark, the "jolli" logotype, and "Code" set in the application's
 * own type. Replaces upstream's `opencode` wordmark.
 *
 * ⚠ "Code" IS TYPE, NOT ARTWORK, AND IT IS INSIDE THE SVG ANYWAY. The brand ships a logo for
 * "jolli" and nothing for the product name, so the second word has to be set rather than drawn.
 * Setting it as a sibling HTML element would leave two independently-scaled boxes to align by
 * eye at every breakpoint; a `<text>` node in the logo's own coordinate system shares the
 * baseline and the scale factor by construction.
 *
 * ⚠ `font-size` IS DERIVED FROM THE X-HEIGHT, NOT THE CAP-HEIGHT, even though the word now leads
 * with a capital: 96.5 units is the logotype's "o" (52.7) ÷ Inter's 0.546em x-height, which makes
 * "ode" sit exactly on "olli". The "C" lands at ≈70 units against the logotype's 74-unit
 * ascenders — caps a little under ascenders is what type does, and matching the cap instead would
 * have shrunk the lowercase below the logotype it sits beside. Re-derive this if the app's font
 * changes; `viewBox` width is the text's measured advance, so re-measure that at the same time.
 *
 * ⚠ THE FADE IS KEPT FROM WHAT IT REPLACES, IN BOTH SENSES. Upstream's wordmark was a watermark:
 * ~7% alpha under a gradient that dissolved its lower half into the page. A brand logo cannot be
 * ghosted that far — the point of putting it here is that it is legible — so the bottom gradient
 * stays but is pulled back to the last quarter, where it reads as the lockup settling onto the
 * page rather than as a logo cut in half. The 400ms opacity ramp is the second sense: the hero
 * arrives rather than appearing.
 *
 * ⚠ SMIL RATHER THAN A KEYFRAME. This component lives in the design-system package and is rendered
 * by an app whose stylesheet it does not own; `<animate>` keeps the whole effect inside the one
 * file that is responsible for it.
 */
export function WordmarkV2(props: Pick<ComponentProps<"svg">, "class">) {
  const mask = createUniqueId()
  const maskGradient = createUniqueId()

  return (
    <svg
      data-component="jolli-code-wordmark"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 592 108.72"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g mask={`url(#${mask})`} opacity="0">
        <animate attributeName="opacity" from="0" to="1" dur="0.4s" begin="0s" fill="freeze" />
        <JolliMarkBody />
        <JolliLogotypeBody />
        <text
          x="359"
          y="90.7"
          fill="currentColor"
          font-size="96.5"
          font-weight="600"
          letter-spacing="0"
          style={{ "font-family": "inherit" }}
        >
          Code
        </text>
      </g>
      <defs>
        <mask id={mask} style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="592" height="108.72">
          <rect width="592" height="108.72" fill={`url(#${maskGradient})`} />
        </mask>
        <linearGradient id={maskGradient} x1="0" y1="80" x2="0" y2="108.72" gradientUnits="userSpaceOnUse">
          <stop stop-color="white" />
          <stop offset="1" stop-color="white" stop-opacity="0.25" />
        </linearGradient>
      </defs>
    </svg>
  )
}
