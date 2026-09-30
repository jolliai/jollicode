import { describe, expect, test } from "bun:test"
import { releaseEntry } from "../src/changelog"

describe("releaseEntry", () => {
  test("takes the version and notes from the top section only", () => {
    const text = [
      "# Jolli Code CLI changelog",
      "",
      "Intro text above the first release is ignored.",
      "",
      "## 0.2.0",
      "",
      "- Added a thing",
      "- Fixed a thing",
      "",
      "## 0.1.0",
      "",
      "- Older entry",
      "",
    ].join("\n")
    expect(releaseEntry(text)).toEqual({ version: "0.2.0", notes: "- Added a thing\n- Fixed a thing" })
  })

  test("reads the last section to the end of the file", () => {
    expect(releaseEntry("## 1.0.0\r\n\r\n- Only entry\r\n")).toEqual({ version: "1.0.0", notes: "- Only entry" })
  })

  test("keeps sub-headings inside the section", () => {
    expect(releaseEntry("## 1.0.0\n\n### Bugfixes\n\n- Fixed\n").notes).toBe("### Bugfixes\n\n- Fixed")
  })

  test("rejects a changelog without a release section", () => {
    expect(() => releaseEntry("# Changelog\n", "cli/CHANGELOG.md")).toThrow(
      'cli/CHANGELOG.md has no "## MAJOR.MINOR.PATCH" section',
    )
  })

  test("rejects a top heading that is not a plain version", () => {
    expect(() => releaseEntry("## Unreleased\n\n- x\n")).toThrow('"## Unreleased" is not "## MAJOR.MINOR.PATCH"')
    expect(() => releaseEntry("## v1.0.0\n\n- x\n")).toThrow('"## v1.0.0" is not "## MAJOR.MINOR.PATCH"')
    expect(() => releaseEntry("## 1.0.0-beta.1\n\n- x\n")).toThrow("is not")
  })

  test("rejects an empty top section", () => {
    expect(() => releaseEntry("## 1.1.0\n\n## 1.0.0\n\n- x\n")).toThrow("the 1.1.0 section is empty")
  })
})

describe("releaseEntry with fenced code", () => {
  test("keeps a fenced ## line inside the section", () => {
    const text = [
      "## 1.1.0",
      "",
      "- Example:",
      "",
      "```md",
      "## Not a release",
      "```",
      "",
      "- After",
      "",
      "## 1.0.0",
      "- Old",
    ].join("\n")
    expect(releaseEntry(text)).toEqual({
      version: "1.1.0",
      notes: "- Example:\n\n```md\n## Not a release\n```\n\n- After",
    })
  })

  test("ignores a fenced ## line above the first release", () => {
    expect(releaseEntry("~~~\n## example\n~~~\n\n## 2.0.0\n\n- x\n").version).toBe("2.0.0")
  })

  test("does not close a ``` fence with ~~~", () => {
    const text = ["## 1.0.0", "```", "~~~", "## still code", "```", "- tail"].join("\n")
    expect(releaseEntry(text).notes).toBe("```\n~~~\n## still code\n```\n- tail")
  })
})

describe("releaseEntry fence rules", () => {
  test("a longer fence is not closed by a shorter one", () => {
    const text = ["## 1.0.0", "````md", "```", "## inner", "```", "````", "- tail", "## 0.9.0", "- old"].join("\n")
    expect(releaseEntry(text).notes).toBe("````md\n```\n## inner\n```\n````\n- tail")
  })

  test("a fence line with an info string does not close the block", () => {
    const text = ["## 1.0.0", "```", "```js", "## inner", "```", "- tail"].join("\n")
    expect(releaseEntry(text).notes).toBe("```\n```js\n## inner\n```\n- tail")
  })
})
