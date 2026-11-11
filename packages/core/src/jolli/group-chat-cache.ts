import { and, asc, eq, gte, inArray, lt, notInArray } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import { Jolli } from "@opencode-ai/schema/jolli"
import type { Database } from "../database/database"
import { Hash } from "../util/hash"
import { parseJolliUrl } from "./origin"
import { JolliGroupChatCacheTable } from "./sql"

export const MAX_CHAT_MESSAGES = 500
export const MAX_ACCOUNT_CHATS = 50
export const MAX_CACHE_AGE = 7 * 24 * 60 * 60 * 1000
/**
 * How often a read also deletes expired rows. Reads skip them on their own, so this only bounds how
 * long an expired copy stays on disk.
 */
const EXPIRY_INTERVAL = 60 * 60 * 1000

/** HTTP refusals and application failures never become offline reads. */
export function canReadOffline(status: number | undefined) {
  return status === undefined || status === 502 || status === 503 || status === 504
}

/** A failed credential refresh is an outage, whereas a rejected credential is a sign-out. */
export function offlineCredentialFailure(error: unknown) {
  return error instanceof Error && "_tag" in error && error._tag === "Jolli.Unavailable"
}

const decodeChat = Schema.decodeUnknownOption(Schema.fromJsonString(Jolli.GroupChat))

/**
 * THE PERSON A CREDENTIAL SIGNS IN: the deployment and tenant it addresses and the subject it names, or its key
 * when it names none. A user id alone is not a person, since two deployments (or two tenants of one) number
 * their users apart. A chat list answer carries it (`owner`) so a window can tell whose group chats it holds,
 * and a sign-in keeps the offline copies only under the same one. Hashed: it is only ever compared, and the
 * renderer keeps it.
 */
export function groupChatOwner(row: { base_url: string | null; subject: string | null; cache_key: string }) {
  const tenant = row.base_url && URL.canParse(row.base_url) ? parseJolliUrl(row.base_url) : undefined
  return Hash.sha256(
    JSON.stringify([
      tenant?.origin ?? row.base_url ?? "",
      tenant?.tenantSlug ?? "",
      row.subject === null ? { key: row.cache_key } : { subject: row.subject },
    ]),
  )
}

export function makeGroupChatCache(database: Database.Interface) {
  const db = database.db
  const versions = new Map<string, number>()
  const unconfirmed = new Set<string>()
  /** Raised by `forget`, so every version changes at once and an in-flight `put` is dropped. */
  let generation = 0
  /** The account the last `forget` kept, and the generation its versions still count from. */
  let kept: { account: string; generation: number } | undefined
  /** When expired rows were last deleted; the store's startup expiry counts. */
  let expired = 0
  const key = (account: string, id: string) => `${account}\n${id}`
  const where = (account: string, id: string) =>
    and(eq(JolliGroupChatCacheTable.account_id, account), eq(JolliGroupChatCacheTable.chat_id, id))
  const fresh = (now: number) => gte(JolliGroupChatCacheTable.validated_at, now - MAX_CACHE_AGE)
  const execute = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)
  const expire = async (now = Date.now()) => {
    await execute(
      db
        .delete(JolliGroupChatCacheTable)
        .where(lt(JolliGroupChatCacheTable.validated_at, now - MAX_CACHE_AGE))
        .run()
        .pipe(Effect.orDie),
    )
    // Stamped only once the purge went through, so a failed one is tried again on the next read.
    expired = now
  }
  const expireWhenDue = (now: number) => (now - expired >= EXPIRY_INTERVAL ? expire(now) : Promise.resolve())
  const version = (account: string, id: Jolli.GroupChatID) =>
    (kept?.account === account ? kept.generation : generation) + (versions.get(key(account, id)) ?? 0)
  const invalidate = (account: string, id: string) => {
    const entry = key(account, id)
    versions.set(entry, (versions.get(entry) ?? 0) + 1)
    unconfirmed.add(entry)
  }
  /** One statement for any number of an account's rows. */
  const drop = async (account: string, ids: readonly string[]) => {
    if (!ids.length) return
    await execute(
      db
        .delete(JolliGroupChatCacheTable)
        .where(
          and(eq(JolliGroupChatCacheTable.account_id, account), inArray(JolliGroupChatCacheTable.chat_id, [...ids])),
        )
        .run()
        .pipe(Effect.orDie),
    )
  }
  return {
    expire,
    version,
    /**
     * Every account's rows but `keep`'s are being deleted (a sign-out keeps none, a sign-in the account it
     * signs in); reads under way for them must not write back. The kept account's versions do not move, so
     * its own reads still land.
     */
    forget(keep?: string) {
      kept =
        keep === undefined
          ? undefined
          : { account: keep, generation: kept?.account === keep ? kept.generation : generation }
      generation++
      Array.from(unconfirmed)
        .filter((entry) => keep === undefined || !entry.startsWith(`${keep}\n`))
        .forEach((entry) => unconfirmed.delete(entry))
    },
    /** Every account's rows go and no read under way writes one back: a sign-out with no credential left to remove. */
    async clear() {
      this.forget()
      await execute(db.delete(JolliGroupChatCacheTable).run().pipe(Effect.orDie))
    },
    /**
     * Keeps what a read made under version `expected` returned, unless the version moved while the read was out
     * (the copy was invalidated, or `forget` dropped its account); a move during the write removes the row again.
     *
     * ⚠ VERSIONS ARE THIS PROCESS'S MEMORY, SO A CREDENTIAL ANOTHER PROCESS REMOVED OR REPLACED MOVES NONE OF THEM.
     * A read this process still had out then writes its row after that process purged the table, and nothing here
     * can tell. The row is filed under a key no credential holds any more (a sign-in after a removal mints another),
     * so no read serves it, and it goes with the next sign-in (which keeps only the account it signs in), an
     * explicit sign-out in either process (`clear`), or its expiry.
     */
    async put(account: string, chat: Jolli.GroupChat, expected: number, now = Date.now()) {
      if (version(account, chat.id) !== expected) return
      await execute(
        db
          .transaction((tx) =>
            Effect.gen(function* () {
              const values = {
                account_id: account,
                chat_id: chat.id,
                course_id: chat.courseId,
                payload: JSON.stringify({ ...chat, messages: chat.messages.slice(-MAX_CHAT_MESSAGES) }),
                validated_at: now,
                accessed_at: now,
                confirmed: true,
                truncated: chat.messages.length > MAX_CHAT_MESSAGES,
              }
              yield* tx
                .insert(JolliGroupChatCacheTable)
                .values(values)
                .onConflictDoUpdate({
                  target: [JolliGroupChatCacheTable.account_id, JolliGroupChatCacheTable.chat_id],
                  set: values,
                })
                .run()
              const rows = yield* tx
                .select({ id: JolliGroupChatCacheTable.chat_id })
                .from(JolliGroupChatCacheTable)
                .where(eq(JolliGroupChatCacheTable.account_id, account))
                .orderBy(asc(JolliGroupChatCacheTable.accessed_at))
                .all()
              const evicted = rows.slice(0, Math.max(0, rows.length - MAX_ACCOUNT_CHATS)).map((row) => row.id)
              if (evicted.length)
                yield* tx
                  .delete(JolliGroupChatCacheTable)
                  .where(
                    and(
                      eq(JolliGroupChatCacheTable.account_id, account),
                      inArray(JolliGroupChatCacheTable.chat_id, evicted),
                    ),
                  )
                  .run()
            }),
          )
          .pipe(Effect.orDie),
      )
      if (version(account, chat.id) === expected) {
        unconfirmed.delete(key(account, chat.id))
        return
      }
      await this.remove(account, chat.id)
    },
    async list(account: string, now = Date.now()) {
      await expireWhenDue(now)
      const rows = await execute(
        db
          .select()
          .from(JolliGroupChatCacheTable)
          .where(
            and(
              eq(JolliGroupChatCacheTable.account_id, account),
              eq(JolliGroupChatCacheTable.confirmed, true),
              fresh(now),
            ),
          )
          .orderBy(asc(JolliGroupChatCacheTable.accessed_at))
          .all()
          .pipe(Effect.orDie),
      )
      const entries = rows.map((row) => ({ row, chat: Option.getOrUndefined(decodeChat(row.payload)) }))
      // A row this version cannot read is deleted rather than failing every offline list.
      await drop(
        account,
        entries.flatMap((entry) => (entry.chat ? [] : [entry.row.chat_id])),
      )
      return entries.flatMap((entry) =>
        entry.chat && !unconfirmed.has(key(account, entry.chat.id))
          ? [{ chat: entry.chat, validatedAt: entry.row.validated_at, truncated: entry.row.truncated }]
          : [],
      )
    },
    async get(account: string, id: Jolli.GroupChatID, now = Date.now()) {
      if (unconfirmed.has(key(account, id))) return
      await expireWhenDue(now)
      const row = await execute(
        db
          .select()
          .from(JolliGroupChatCacheTable)
          .where(and(where(account, id), fresh(now)))
          .get()
          .pipe(Effect.orDie),
      )
      if (!row?.confirmed) return
      const chat = Option.getOrUndefined(decodeChat(row.payload))
      if (!chat) {
        await drop(account, [id])
        return
      }
      await execute(
        db
          .update(JolliGroupChatCacheTable)
          .set({ accessed_at: now })
          .where(where(account, id))
          .run()
          .pipe(Effect.orDie),
      )
      return { chat, validatedAt: row.validated_at, truncated: row.truncated }
    },
    async unconfirm(account: string, id: Jolli.GroupChatID) {
      invalidate(account, id)
      await execute(
        db
          .update(JolliGroupChatCacheTable)
          .set({ confirmed: false })
          .where(where(account, id))
          .run()
          .pipe(Effect.orDie),
      )
    },
    async remove(account: string, id: Jolli.GroupChatID) {
      invalidate(account, id)
      await drop(account, [id])
    },
    async reconcile(account: string, ids: readonly string[], complete: boolean, courseId?: string) {
      if (!complete) return
      const rows = await execute(
        db
          .select({ id: JolliGroupChatCacheTable.chat_id })
          .from(JolliGroupChatCacheTable)
          .where(
            and(
              eq(JolliGroupChatCacheTable.account_id, account),
              ...(courseId ? [eq(JolliGroupChatCacheTable.course_id, courseId)] : []),
              ...(ids.length ? [notInArray(JolliGroupChatCacheTable.chat_id, [...ids])] : []),
            ),
          )
          .all()
          .pipe(Effect.orDie),
      )
      // Every version moves before the rows go, as `remove` does, so a read still on its way is dropped.
      for (const row of rows) invalidate(account, row.id)
      await drop(
        account,
        rows.map((row) => row.id),
      )
    },
  }
}
export type GroupChatCache = ReturnType<typeof makeGroupChatCache>
