// Jolli Code wordmark — "jolli code" in the figlet "Slant" font.
// String.raw keeps the backslashes literal (no escaping). Rendered in a single
// foreground color by consumers (black/white, following the theme).
export const logo = String.raw`       __      _____    ______          __
      / /___  / / (_)  / ____/___  ____/ /__
 __  / / __ \/ / / /  / /   / __ \/ __  / _ \
/ /_/ / /_/ / / / /  / /___/ /_/ / /_/ /  __/
\____/\____/_/_/_/   \____/\____/\__,_/\___/`.split("\n")

// Small "go" glyph used by the run-mode splash / background pulse. Unchanged.
export const go = {
  left: ["    ", "█▀▀▀", "█_^█", "▀▀▀▀"],
  right: ["    ", "█▀▀█", "█__█", "▀▀▀▀"],
}
