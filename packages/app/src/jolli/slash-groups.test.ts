import { describe, expect, test } from "bun:test"
import { ASSISTANTS } from "./fixtures"
import { groupSlashCommands, OTHER_SLASH_GROUP } from "./slash-groups"

const custom = (trigger: string) => ({ trigger, type: "custom" as const })
const builtin = (trigger: string) => ({ trigger, type: "builtin" as const })

const coder = ASSISTANTS.find((assistant) => assistant.id === "cs-310-code")!
const desk = ASSISTANTS.find((assistant) => assistant.skills.length === 0)!

describe("groupSlashCommands", () => {
  test("lifts the assistant's own procedures above everything else", () => {
    const result = groupSlashCommands([builtin("init"), custom("read-the-error"), builtin("review")], coder)
    expect(result.map((item) => item.trigger)).toEqual(["read-the-error", "init", "review"])
  })

  test("labels the assistant's rows with its name and the rest with one shared header", () => {
    const result = groupSlashCommands([builtin("init"), custom("plan-the-change")], coder)
    expect(result.map((item) => item.group)).toEqual([coder.name, OTHER_SLASH_GROUP])
  })

  test("keeps rows sharing a group adjacent, so the popover draws each header once", () => {
    const rows = [custom("read-the-error"), builtin("init"), custom("plan-the-change"), builtin("review")]
    const groups = groupSlashCommands(rows, coder).map((item) => item.group)
    expect(groups).toEqual([coder.name, coder.name, OTHER_SLASH_GROUP, OTHER_SLASH_GROUP])
  })

  test("preserves upstream's relative order within each group", () => {
    const rows = [custom("plan-the-change"), custom("read-the-error"), builtin("review"), builtin("init")]
    const result = groupSlashCommands(rows, coder)
    expect(result.map((item) => item.trigger)).toEqual(["plan-the-change", "read-the-error", "review", "init"])
  })

  /**
   * The guard that keeps a lone "Other commands" header off a list it would not describe. Each of
   * these is a real state: no course chosen yet, an assistant a professor gave no procedures, and a
   * course whose procedures the server has not listed.
   */
  test("groups nothing when there is nothing of the assistant's to lift", () => {
    for (const [label, assistant] of [
      ["no assistant", undefined],
      ["assistant with no skills", desk],
      ["assistant whose skills are absent from the list", coder],
    ] as const) {
      const result = groupSlashCommands([builtin("init"), custom("commit")], assistant)
      expect(
        result.map((item) => item.group),
        label,
      ).toEqual([undefined, undefined])
      expect(
        result.map((item) => item.trigger),
        label,
      ).toEqual(["init", "commit"])
    }
  })

  /**
   * ⚠ A BUILTIN IS NEVER THE COURSE'S, even when its trigger matches a skillId exactly. Skills reach
   * this list as `custom` rows; a palette entry that collides is a coincidence, not a procedure.
   */
  test("never claims a builtin, even when its trigger collides with a skillId", () => {
    const result = groupSlashCommands([builtin("read-the-error"), custom("plan-the-change")], coder)
    expect(result.map((item) => item.trigger)).toEqual(["plan-the-change", "read-the-error"])
    expect(result[1]?.group).toBe(OTHER_SLASH_GROUP)
  })

  test("matches every procedure the fixtures give an assistant", () => {
    const rows = coder.skills.map((skill) => custom(skill.skillId))
    const result = groupSlashCommands([...rows, builtin("init")], coder)
    expect(result.filter((item) => item.group === coder.name)).toHaveLength(coder.skills.length)
  })
})
