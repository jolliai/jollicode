import { expect, test } from "bun:test"
import type { Configuration } from "electron-builder"
import { Brand } from "@opencode-ai/app/brand"

const expectedAppIds = {
  dev: `${Brand.appId}.dev`,
  beta: `${Brand.appId}.beta`,
  prod: Brand.appId,
} as const

const channels = [
  { channel: "dev", appId: expectedAppIds.dev, productName: "Jolli Code Dev" },
  { channel: "beta", appId: expectedAppIds.beta, productName: "Jolli Code Beta" },
  { channel: "prod", appId: expectedAppIds.prod, productName: "Jolli Code" },
] as const

for (const channel of channels) {
  test(`uses one Linux desktop identity for ${channel.channel}`, async () => {
    const previous = process.env.OPENCODE_CHANNEL
    process.env.OPENCODE_CHANNEL = channel.channel

    const module = await import(`./electron-builder.config.ts?channel=${channel.channel}`)
    const config = module.default as Configuration

    if (previous === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = previous

    expect(config.appId).toBe(channel.appId)
    expect(config.extraMetadata?.desktopName).toBe(`${channel.appId}.desktop`)
    expect(config.linux?.executableName).toBe(channel.appId)
    expect(config.linux?.desktop?.entry?.StartupWMClass).toBe(channel.appId)
    expect(config.deb?.fpm).toContainEqual(expect.stringContaining(`/usr/share/metainfo/${channel.appId}.metainfo.xml`))
    expect(config.rpm?.fpm).toContainEqual(expect.stringContaining(`/usr/share/metainfo/${channel.appId}.metainfo.xml`))
    expect(config.productName).toBe(channel.productName)
    expect(config.protocols).toMatchObject({ schemes: [Brand.protocol] })
    expect(config.artifactName).toBe("jollicode-desktop-${os}-${arch}.${ext}")
  })
}

test("build config appIds match Brand-derived ids", () => {
  expect(expectedAppIds).toEqual({
    dev: "ai.jolli.desktop.dev",
    beta: "ai.jolli.desktop.beta",
    prod: "ai.jolli.desktop",
  })
})

test("publishes desktop releases to the jolliai releases repos", async () => {
  const previousChannel = process.env.OPENCODE_CHANNEL

  process.env.OPENCODE_CHANNEL = "beta"
  const betaModule = await import("./electron-builder.config.ts?publish=beta")
  const betaConfig = betaModule.default as Configuration

  process.env.OPENCODE_CHANNEL = "prod"
  const prodModule = await import("./electron-builder.config.ts?publish=prod")
  const prodConfig = prodModule.default as Configuration

  if (previousChannel === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = previousChannel

  expect(betaConfig.publish).toEqual({
    provider: "github",
    owner: "jolliai",
    repo: "jollicode-releases-beta",
    channel: "latest",
  })
  expect(prodConfig.publish).toEqual({ provider: "github", owner: "jolliai", repo: "jollicode-releases", channel: "latest" })
})

test("rpm packageName matches the Jolli brand per channel", async () => {
  const previousChannel = process.env.OPENCODE_CHANNEL

  process.env.OPENCODE_CHANNEL = "dev"
  const devModule = await import("./electron-builder.config.ts?rpm=dev")
  const devConfig = devModule.default as Configuration

  process.env.OPENCODE_CHANNEL = "beta"
  const betaModule = await import("./electron-builder.config.ts?rpm=beta")
  const betaConfig = betaModule.default as Configuration

  process.env.OPENCODE_CHANNEL = "prod"
  const prodModule = await import("./electron-builder.config.ts?rpm=prod")
  const prodConfig = prodModule.default as Configuration

  if (previousChannel === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = previousChannel

  expect(devConfig.rpm?.packageName).toBe("jollicode-dev")
  expect(betaConfig.rpm?.packageName).toBe("jollicode-beta")
  expect(prodConfig.rpm?.packageName).toBe("jollicode")
})

test("bundles the CLI outside the dev app archive", async () => {
  const previous = process.env.OPENCODE_CHANNEL
  process.env.OPENCODE_CHANNEL = "dev"
  const module = await import("./electron-builder.config.ts?cli-resource")
  const config = module.default as Configuration
  if (previous === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = previous

  expect(config.files).toContain("!resources/jollicode-cli*")
  expect(config.extraResources).toContainEqual({
    from: "resources/",
    to: "",
    filter: ["jollicode-cli*"],
  })
})

for (const channel of ["beta", "prod"] as const) {
  test(`does not bundle the CLI in ${channel} builds`, async () => {
    const previous = process.env.OPENCODE_CHANNEL
    process.env.OPENCODE_CHANNEL = channel
    const module = await import(`./electron-builder.config.ts?no-cli-resource=${channel}`)
    const config = module.default as Configuration
    if (previous === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = previous

    expect(config.extraResources).not.toContainEqual({
      from: "resources/",
      to: "",
      filter: ["jollicode-cli*"],
    })
  })
}
