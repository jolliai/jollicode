import { sentryVitePlugin } from "@sentry/vite-plugin"
import { defineConfig } from "vite"
import { modulesPlugin } from "@opencode-ai/script/bundle-modules"
import desktopPlugin from "./vite"

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./dist/**",
          filesToDeleteAfterUpload: "./dist/**/*.map",
        },
      })
    : false

export default defineConfig({
  // Only the CLI build, which embeds dist/ and lists its modules in the binary's license manifest,
  // asks for the module list. The web deploy serves dist/ publicly, and the list would expose the build
  // machine's paths and every dependency version.
  plugins: [desktopPlugin, sentry, ...(process.env.OPENCODE_RECORD_MODULES ? [modulesPlugin()] : [])] as any,
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3000,
  },
  build: {
    target: "esnext",
    sourcemap: true,
  },
})
