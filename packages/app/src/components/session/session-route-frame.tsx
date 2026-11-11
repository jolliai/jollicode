import type { ParentProps } from "solid-js"

/**
 * ⚠ THE PANE IS FLUSH WITH THE SIDEBAR, NOT INSET FROM IT. This used to add `p-2` and let the
 * shell's `bg-deep` show through as a gutter around a rounded, raised card. That reads as a canvas
 * only when the canvas is visible; at `#fafafa` under a `#ffffff` card it read as stray whitespace
 * beside the sidebar, with a shadow and a corner radius floating on nothing. The boundary is the
 * sidebar's own edge now (`app-sidebar.tsx`), which states it at one pixel instead of eight.
 *
 * ⚠ `padded` IS KEPT AS A NO-OP ON PURPOSE — see `SessionRouteErrorBoundary`, whose callers pass
 * it. Deleting the prop is a wider change than this one, and the flag still names a real question
 * ("is this route inset?") that a future layout may answer differently.
 */
export function SessionRouteFrame(props: ParentProps<{ padded?: boolean }>) {
  void props.padded
  return <div class="relative size-full overflow-hidden flex flex-col">{props.children}</div>
}
