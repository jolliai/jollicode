import { defineConfig } from "drizzle-kit"
import path from "path"
import { xdgData } from "xdg-basedir"
import { Brand } from "./src/brand"

export default defineConfig({
  dialect: "sqlite",
  schema: ["./src/**/*.sql.ts", "./src/**/sql.ts"],
  out: "./migration",
  dbCredentials: {
    // Mirror Global.Path.data (<xdgData>/<bin>) and the default DB name; overridable like the app.
    url: process.env.JOLLICODE_DB || path.join(xdgData!, Brand.bin, `${Brand.bin}.db`),
  },
})
