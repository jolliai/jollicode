import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261110100530_jolli_group_chat_cache",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`jolli_group_chat_cache\` (
          \`account_id\` text NOT NULL,
          \`chat_id\` text NOT NULL,
          \`course_id\` text NOT NULL,
          \`payload\` text NOT NULL,
          \`validated_at\` integer NOT NULL,
          \`accessed_at\` integer NOT NULL,
          \`confirmed\` integer NOT NULL,
          \`truncated\` integer NOT NULL,
          CONSTRAINT \`jolli_group_chat_cache_pk\` PRIMARY KEY(\`account_id\`, \`chat_id\`)
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
