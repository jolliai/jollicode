import { resolveChannel } from "./utils"

const arg = process.argv[2]
const channel = arg === "dev" || arg === "beta" || arg === "prod" ? arg : resolveChannel()

const appId = channel === "prod" ? "ai.jolli.desktop" : `ai.jolli.desktop.${channel}`
const productName = channel === "prod" ? "Jolli Code" : `Jolli Code ${channel.charAt(0).toUpperCase() + channel.slice(1)}`
const summary = `AI coding agent for learning${channel !== "prod" ? ` (${channel})` : ""}`

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${appId}</id>

  <metadata_license>CC0-1.0</metadata_license>
  <project_license>LicenseRef-proprietary</project_license>

  <name>${productName}</name>
  <summary>${summary}</summary>

  <developer id="ai.jolli">
    <name>Jolli</name>
  </developer>

  <description>
    <p>
      Jolli Code is an AI coding agent for learning, built to help students write and run code with approved AI models.
    </p>
  </description>

  <launchable type="desktop-id">${appId}.desktop</launchable>

  <content_rating type="oars-1.1" />

  <url type="bugtracker">https://github.com/jolliai/jollicode/issues</url>
  <url type="homepage">https://jolli.ai</url>
  <url type="vcs-browser">https://github.com/jolliai/jollicode</url>
</component>
`

await Bun.write(`resources/${appId}.metainfo.xml`, xml)
console.log(`Generated metainfo for ${channel} at resources/${appId}.metainfo.xml`)
