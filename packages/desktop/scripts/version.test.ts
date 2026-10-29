import { describe, expect, test } from "bun:test"
import { latestDesktopTag, releaseVersion, requireCliVersion, shouldReuseRelease, staleDesktopDrafts } from "./version"

const published = (tagName: string) => ({ tagName, isDraft: false, isPrerelease: false })

describe("latestDesktopTag", () => {
  test("picks the highest version by semver, not by list order or string order", () => {
    expect(
      latestDesktopTag([published("desktop-v1.9.0"), published("desktop-v1.10.0"), published("desktop-v1.2.0")]),
    ).toBe("desktop-v1.10.0")
  })

  test("ignores drafts and prereleases", () => {
    expect(
      latestDesktopTag([
        { tagName: "desktop-v2.0.0", isDraft: true, isPrerelease: false },
        { tagName: "desktop-v1.5.0", isDraft: false, isPrerelease: true },
        published("desktop-v1.4.0"),
      ]),
    ).toBe("desktop-v1.4.0")
  })

  test("ignores releases that are not desktop-v tags", () => {
    expect(latestDesktopTag([published("v9.9.9"), published("desktop-v1.2.0")])).toBe("desktop-v1.2.0")
  })

  test("returns undefined when there is no desktop release yet", () => {
    expect(latestDesktopTag([])).toBeUndefined()
  })
})

describe("releaseVersion", () => {
  test("accepts any changelog version when there is no published desktop release", () => {
    expect(releaseVersion({ version: "0.0.1" })).toBe("0.0.1")
    expect(releaseVersion({ version: "1.0.0" })).toBe("1.0.0")
  })

  test("accepts a changelog version newer than the latest desktop-v tag", () => {
    expect(releaseVersion({ version: "1.4.10", latestTag: "desktop-v1.4.9" })).toBe("1.4.10")
    expect(releaseVersion({ version: "2.0.0", latestTag: "desktop-v1.4.9" })).toBe("2.0.0")
  })

  test("rejects a changelog version that is not newer than the latest release", () => {
    expect(() => releaseVersion({ version: "1.2.0", latestTag: "desktop-v1.5.0" })).toThrow(
      "not newer than the latest desktop release 1.5.0",
    )
    expect(() => releaseVersion({ version: "1.5.0", latestTag: "desktop-v1.5.0" })).toThrow(
      "add a section for the new release",
    )
  })

  test("rejects versions that are not MAJOR.MINOR.PATCH", () => {
    expect(() => releaseVersion({ version: "1.2" })).toThrow("not a MAJOR.MINOR.PATCH version")
    expect(() => releaseVersion({ version: "1.2.0-beta.1" })).toThrow("not a MAJOR.MINOR.PATCH version")
  })
})

describe("shouldReuseRelease", () => {
  test("creates a release when none exists", () => {
    expect(shouldReuseRelease("desktop-v1.0.0", undefined)).toBe(false)
  })

  test("reuses a draft left by a failed run", () => {
    expect(shouldReuseRelease("desktop-v1.0.0", { isDraft: true })).toBe(true)
  })

  test("refuses to republish a published release", () => {
    expect(() => shouldReuseRelease("desktop-v1.0.0", { isDraft: false })).toThrow(
      "desktop-v1.0.0 is already published",
    )
  })
})

describe("staleDesktopDrafts", () => {
  test("lists desktop drafts left by earlier failed runs, except the one being released", () => {
    expect(
      staleDesktopDrafts(
        [
          { tagName: "desktop-v1.0.2", isDraft: true, isPrerelease: false },
          { tagName: "desktop-v1.1.0", isDraft: true, isPrerelease: false },
          published("desktop-v1.0.1"),
        ],
        "desktop-v1.1.0",
      ),
    ).toEqual(["desktop-v1.0.2"])
  })

  test("leaves drafts that are not desktop releases alone", () => {
    expect(
      staleDesktopDrafts([{ tagName: "notes-draft", isDraft: true, isPrerelease: false }], "desktop-v1.0.0"),
    ).toEqual([])
  })
})

describe("requireCliVersion", () => {
  test("pins the published CLI version", () => {
    expect(requireCliVersion("1.4.2\n")).toBe("1.4.2")
  })

  test("refuses to release before a real CLI is published", () => {
    expect(() => requireCliVersion("0.0.0")).toThrow("publish the CLI first")
    expect(() => requireCliVersion("")).toThrow("publish the CLI first")
  })
})
