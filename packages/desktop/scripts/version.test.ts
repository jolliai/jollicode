import { describe, expect, test } from "bun:test"
import { latestDesktopTag, nextDesktopVersion, shouldReuseRelease } from "./version"

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

describe("nextDesktopVersion", () => {
  test("bumps from 0.0.0 when there is no published desktop release", () => {
    expect(nextDesktopVersion({ bump: "patch" })).toBe("0.0.1")
    expect(nextDesktopVersion({ bump: "minor" })).toBe("0.1.0")
    expect(nextDesktopVersion({ bump: "major" })).toBe("1.0.0")
  })

  test("bumps the latest desktop-v tag", () => {
    expect(nextDesktopVersion({ latestTag: "desktop-v1.4.9", bump: "patch" })).toBe("1.4.10")
    expect(nextDesktopVersion({ latestTag: "desktop-v1.4.9", bump: "minor" })).toBe("1.5.0")
    expect(nextDesktopVersion({ latestTag: "desktop-v1.4.9", bump: "major" })).toBe("2.0.0")
  })

  test("an explicit version wins over bump and accepts a tag-style prefix", () => {
    expect(nextDesktopVersion({ latestTag: "desktop-v1.0.0", bump: "patch", override: "3.1.4" })).toBe("3.1.4")
    expect(nextDesktopVersion({ bump: "patch", override: "v3.1.4" })).toBe("3.1.4")
    expect(nextDesktopVersion({ bump: "patch", override: "desktop-v3.1.4" })).toBe("3.1.4")
  })

  test("rejects an explicit version that is not newer than the latest release", () => {
    expect(() => nextDesktopVersion({ latestTag: "desktop-v1.5.0", bump: "patch", override: "1.2.0" })).toThrow(
      "not newer than the latest desktop release 1.5.0",
    )
    expect(() => nextDesktopVersion({ latestTag: "desktop-v1.5.0", bump: "patch", override: "1.5.0" })).toThrow(
      "not newer than the latest desktop release 1.5.0",
    )
  })

  test("rejects versions that are not MAJOR.MINOR.PATCH", () => {
    expect(() => nextDesktopVersion({ bump: "patch", override: "1.2" })).toThrow("not a MAJOR.MINOR.PATCH version")
    expect(() => nextDesktopVersion({ bump: "patch", override: "1.2.0-beta.1" })).toThrow(
      "not a MAJOR.MINOR.PATCH version",
    )
  })

  test("rejects an unknown bump", () => {
    expect(() => nextDesktopVersion({ bump: "huge" })).toThrow('Unknown bump "huge"')
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
