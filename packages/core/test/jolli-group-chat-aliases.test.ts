import { replaceAliases } from "../src/jolli/group-chat-rules"
import { describe, expect, it } from "bun:test"

describe("replaceAliases", () => {
  it("replaceAliases swaps whole aliases for names", () => {
    expect(
      replaceAliases(
        "Student A and Teacher 1 agree.",
        [
          { alias: "Student A", userId: 7 },
          { alias: "Teacher 1", userId: 2 },
        ],
        new Map([
          [7, "Ana"],
          [2, "Dr. Lee"],
        ]),
      ),
    ).toBe("Ana and Dr. Lee agree.")
  })

  it("replaceAliases leaves a longer alias alone", () => {
    expect(replaceAliases("Student AB asked.", [{ alias: "Student A", userId: 7 }], new Map([[7, "Ana"]]))).toBe(
      "Student AB asked.",
    )
  })

  it("replaceAliases keeps an alias with no known name", () => {
    expect(replaceAliases("Student C left.", [], new Map())).toBe("Student C left.")
  })

  it("reads the possessive as the person's", () => {
    expect(replaceAliases("Student A's idea works.", [{ alias: "Student A", userId: 7 }], new Map([[7, "Ana"]]))).toBe(
      "Ana's idea works.",
    )
  })

  it("prefers the longer of two aliases that start alike", () => {
    expect(
      replaceAliases(
        "Student A asked Student AB.",
        [
          { alias: "Student A", userId: 7 },
          { alias: "Student AB", userId: 8 },
        ],
        new Map([
          [7, "Ana"],
          [8, "Ben"],
        ]),
      ),
    ).toBe("Ana asked Ben.")
  })

  it("keeps the alias of someone whose name is blank", () => {
    expect(replaceAliases("Teacher 2 said so.", [{ alias: "Teacher 2", userId: 3 }], new Map([[3, " "]]))).toBe(
      "Teacher 2 said so.",
    )
  })
})

/*
 * Answers written while agents were told to answer their asker by name open on that name, and a group
 * chat answer that does gets no `@` chip naming the asker a second time.
 */
