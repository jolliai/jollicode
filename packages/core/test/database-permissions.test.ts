import { describe, expect, test } from "bun:test"
import { chmodSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { restrictDatabaseFile } from "@opencode-ai/core/database/permissions"
import { tmpdir } from "./fixture/tmpdir"

const mode = (file: string) => statSync(file).mode & 0o777

const siblings = (filename: string) => [filename, `${filename}-wal`, `${filename}-shm`]

/**
 * The modes are read while the connection is still open, because SQLite removes `-wal` and `-shm`
 * on a clean close — asserting after the scope ends would stat files that no longer exist.
 */
const openAndReadModes = (filename: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Database.Service
      return siblings(filename).map(mode)
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
  )

// Node's chmod on Windows only toggles the read-only bit; see `database/permissions.ts`.
describe.skipIf(process.platform === "win32")("database permissions", () => {
  test("opens the database owner-only, including its WAL siblings", async () => {
    await using dir = await tmpdir()
    const filename = path.join(dir.path, "jollicode.db")

    expect(await openAndReadModes(filename)).toEqual([0o600, 0o600, 0o600])
  })

  test("tightens a database an older build left world-readable", async () => {
    await using dir = await tmpdir()
    const filename = path.join(dir.path, "jollicode.db")

    await openAndReadModes(filename)
    // What a build without `restrictDatabaseFile` leaves on disk. Reopening has to tighten it, and
    // the siblings WAL then creates must not inherit the loose mode.
    chmodSync(filename, 0o644)

    expect(await openAndReadModes(filename)).toEqual([0o600, 0o600, 0o600])
  })

  test("tightens stale WAL siblings left by an unclean shutdown", async () => {
    await using dir = await tmpdir()
    const filename = path.join(dir.path, "jollicode.db")
    // A crash leaves `-wal`/`-shm` behind, and WAL reuses rather than recreates them — so the main
    // file's mode never reaches them and they have to be tightened directly.
    for (const file of siblings(filename)) writeFileSync(file, "", { mode: 0o644 })

    restrictDatabaseFile(filename)

    expect(siblings(filename).map(mode)).toEqual([0o600, 0o600, 0o600])
  })

  test("leaves in-memory databases alone", () => {
    expect(() => restrictDatabaseFile(":memory:")).not.toThrow()
    expect(() => restrictDatabaseFile("file::memory:?cache=shared")).not.toThrow()
  })
})
