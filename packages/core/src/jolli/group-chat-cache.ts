import { and, asc, eq, lt, notInArray } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import { Jolli } from "@opencode-ai/schema/jolli"
import type { Database } from "../database/database"
import { JolliGroupChatCacheTable } from "./sql"

export const MAX_CHAT_MESSAGES = 500
export const MAX_ACCOUNT_CHATS = 50
export const MAX_CACHE_AGE = 7 * 24 * 60 * 60 * 1000

/** HTTP refusals and application failures never become offline reads. */
export function canReadOffline(status: number | undefined) {
  return status === undefined || status === 502 || status === 503 || status === 504
}

/** A failed credential refresh is an outage, whereas a rejected credential is a sign-out. */
export function offlineCredentialFailure(error: unknown) {
  return error instanceof Error && "_tag" in error && error._tag === "Jolli.Unavailable"
}

const decodeChat = Schema.decodeUnknownOption(Schema.fromJsonString(Jolli.GroupChat))

export function makeGroupChatCache(database: Database.Interface) {
  const db = database.db
  const versions = new Map<string, number>()
  const unconfirmed = new Set<string>()
  /** Raised by `forget`, so every version changes at once and an in-flight `put` is dropped. */
  let generation = 0
  const key = (account: string, id: Jolli.GroupChatID) => `${account}\n${id}`
  const where = (account: string, id: string) =>
    and(eq(JolliGroupChatCacheTable.account_id, account), eq(JolliGroupChatCacheTable.chat_id, id))
  const execute = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)
  const expire = (now = Date.now()) =>
    execute(
      db
        .delete(JolliGroupChatCacheTable)
        .where(lt(JolliGroupChatCacheTable.validated_at, now - MAX_CACHE_AGE))
        .run()
        .pipe(Effect.orDie),
    )
  const version = (account: string, id: Jolli.GroupChatID) => generation + (versions.get(key(account, id)) ?? 0)
  const invalidate = (account: string, id: Jolli.GroupChatID) => {
    const entry = key(account, id)
    versions.set(entry, (versions.get(entry) ?? 0) + 1)
    unconfirmed.add(entry)
  }
  const drop = (account: string, id: string) =>
    execute(db.delete(JolliGroupChatCacheTable).where(where(account, id)).run().pipe(Effect.orDie))
  return {
    expire,
    version,
    /** Every account's rows are being deleted (sign-out or another sign-in); reads under way must not write back. */
    forget() {
      generation++
      unconfirmed.clear()
    },
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
              for (const row of rows.slice(0, Math.max(0, rows.length - MAX_ACCOUNT_CHATS)))
                yield* tx
                  .delete(JolliGroupChatCacheTable)
                  .where(
                    and(eq(JolliGroupChatCacheTable.account_id, account), eq(JolliGroupChatCacheTable.chat_id, row.id)),
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
      await expire(now)
      const rows = await execute(
        db
          .select()
          .from(JolliGroupChatCacheTable)
          .where(and(eq(JolliGroupChatCacheTable.account_id, account), eq(JolliGroupChatCacheTable.confirmed, true)))
          .orderBy(asc(JolliGroupChatCacheTable.accessed_at))
          .all()
          .pipe(Effect.orDie),
      )
      const entries = rows.map((row) => ({ row, chat: Option.getOrUndefined(decodeChat(row.payload)) }))
      // A row this version cannot read is deleted rather than failing every offline list.
      for (const entry of entries) if (!entry.chat) await drop(account, entry.row.chat_id)
      return entries.flatMap((entry) =>
        entry.chat && !unconfirmed.has(key(account, entry.chat.id))
          ? [{ chat: entry.chat, validatedAt: entry.row.validated_at, truncated: entry.row.truncated }]
          : [],
      )
    },
    async get(account: string, id: Jolli.GroupChatID, now = Date.now()) {
      if (unconfirmed.has(key(account, id))) return
      await expire(now)
      const row = await execute(
        db.select().from(JolliGroupChatCacheTable).where(where(account, id)).get().pipe(Effect.orDie),
      )
      if (!row?.confirmed) return
      const chat = Option.getOrUndefined(decodeChat(row.payload))
      if (!chat) {
        await drop(account, id)
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
      await drop(account, id)
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
      for (const row of rows) await this.remove(account, Jolli.GroupChatID.make(row.id))
    },
  }
}
export type GroupChatCache = ReturnType<typeof makeGroupChatCache>
