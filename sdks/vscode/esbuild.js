const esbuild = require("esbuild")
const fs = require("fs")
const path = require("path")

const production = process.argv.includes("--production")
const watch = process.argv.includes("--watch")

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",

  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started")
    })
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`)
        console.error(`    ${location.file}:${location.line}:${location.column}:`)
      })
      console.log("[watch] build finished")
    })
  },
}

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outfile: "dist/extension.js",
    external: ["vscode"],
    logLevel: "silent",
    metafile: production,
    plugins: [
      /* add to the end of plugins array */
      esbuildProblemMatcherPlugin,
    ],
  })
  if (watch) {
    await ctx.watch()
  } else {
    const result = await ctx.rebuild()
    await ctx.dispose()
    if (production) await checkLicenses(result.metafile)
  }
}

// The extension bundles no third-party code: its only import, `vscode`, is external. So it ships the
// repository NOTICE alone; bundling a dependency would also need a THIRD-PARTY-LICENSES manifest like
// the CLI and desktop builds generate.
async function checkLicenses(metafile) {
  const bundled = Object.keys(metafile.inputs).filter((file) => file.includes("node_modules"))
  if (bundled.length > 0) {
    throw new Error(`The extension now bundles third-party modules; ship their licenses:\n${bundled.join("\n")}`)
  }
  await fs.promises.copyFile(path.join(__dirname, "../../NOTICE"), path.join(__dirname, "NOTICE"))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
