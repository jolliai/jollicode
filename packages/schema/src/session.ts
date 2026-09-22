export * as Session from "./session"

import { Schema } from "effect"
import { Agent } from "./agent"
import { Location } from "./location"
import { Model } from "./model"
import { Project } from "./project"
import { DateTimeUtcFromMillis, optional, RelativePath } from "./schema"
import { SessionEvent } from "./session-event"
import { SessionID } from "./session-id"
import { Revert } from "./revert"

export const ID = SessionID
export type ID = SessionID

export const Event = SessionEvent

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  parentID: ID.pipe(optional),
  projectID: Project.ID,
  agent: Agent.ID.pipe(optional),
  model: Model.Ref.pipe(optional),
  cost: Schema.Finite,
  tokens: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cache: Schema.Struct({
      read: Schema.Finite,
      write: Schema.Finite,
    }),
  }),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    archived: DateTimeUtcFromMillis.pipe(optional),
  }),
  title: Schema.String,
  location: Location.Ref,
  subpath: RelativePath.pipe(optional),
  /**
   * ⚠ THE SESSION'S OWN BAG, AND IT WAS MISSING HERE WHILE THE COLUMN EXISTED. `SessionTable` has
   * carried `metadata` since it was written and the v1 `SessionInfo` has always exposed it, but this
   * projection never listed it — so every v2 read (`session.list`, `session.get`, the sidebar's
   * index) answered with the field silently absent. Jolli's course binding lives at `metadata.jolli`
   * (see `core/jolli/binding.ts`), which meant a session opened from the session list came back
   * unbound: no course, no assistant, and — because the assistant is what `ModelGrant` reads — no
   * model grant either. A session created in the same renderer looked fine only because
   * `session-binding.tsx` was still serving it out of its `handoff` map, whose whole purpose is to
   * cover one frame and which could never be retired while the server's copy kept arriving empty.
   */
  metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(optional),
  revert: Revert.State.pipe(optional),
}).annotate({ identifier: "SessionV2.Info" })

export const ListAnchor = Schema.Struct({
  id: ID,
  time: Schema.Finite,
  direction: Schema.Literals(["previous", "next"]),
}).annotate({ identifier: "Session.ListAnchor" })
export interface ListAnchor extends Schema.Schema.Type<typeof ListAnchor> {}
