import path from "path"

// Node-safe on purpose: Vite loads its config, and with it this module, under Node. The Bun-only
// manifest generator that reads these lists lives in ./licenses.

// Bundlers record the modules they inline here, next to their output. Dot-prefixed so the CLI's
// embedded Web UI glob and other `**/*` scans skip it.
export const MODULES_FILE = ".bundle-modules.json"

/**
 * Vite plugin that records every module inlined into the build as MODULES_FILE in its outDir.
 * Assets (fonts, wasm) are not chunk modules, so their source paths come from `originalFileNames`,
 * which Vite reports relative to the project root.
 */
export function modulesPlugin() {
  const state = { root: process.cwd() }
  return {
    name: "jolli:bundle-modules",
    configResolved(config: { root: string }) {
      state.root = config.root
    },
    generateBundle(
      this: { emitFile(file: { type: "asset"; fileName: string; source: string }): string },
      _options: unknown,
      bundle: Record<string, { type: string; modules?: Record<string, unknown>; originalFileNames?: string[] }>,
    ) {
      const modules = Object.values(bundle).flatMap((item) =>
        item.type === "chunk"
          ? Object.keys(item.modules ?? {})
          : (item.originalFileNames ?? []).map((file) => path.resolve(state.root, file)),
      )
      this.emitFile({
        type: "asset",
        fileName: MODULES_FILE,
        source: JSON.stringify([...new Set(modules)].sort(), null, 2),
      })
    },
  }
}
