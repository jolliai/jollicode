import { cmd } from "./cmd"

// NOTICE followed by the third-party manifest generated from this binary's own bundle; injected by
// script/build.ts, so it is absent when running from source.
declare const OPENCODE_LICENSES: string | undefined

export const LicensesCommand = cmd({
  command: "licenses",
  describe: "show open-source license notices for bundled third-party software",
  handler: async () => {
    if (typeof OPENCODE_LICENSES === "undefined") {
      process.stderr.write("License notices are embedded by release builds (packages/opencode/script/build.ts).\n")
      process.exitCode = 1
      return
    }
    // The text is ~1.4 MB; wait for stdout to drain before index.ts calls process.exit(), or a pipe
    // receives only its first buffer's worth. A reader that stops early (`| head`) closes the pipe
    // with EPIPE, which ends the output rather than failing it.
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(OPENCODE_LICENSES, (err) => {
        if (err && !("code" in err && err.code === "EPIPE")) return reject(err)
        resolve()
      })
    })
  },
})
