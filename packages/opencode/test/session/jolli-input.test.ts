import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MAX_STEPS_PROMPT } from "@opencode-ai/core/session/runner/max-steps"
import { JolliInput } from "@/session/jolli-input"
import { MessageID, PartID, SessionID } from "@/session/schema"

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")

function textPart(text: string, extra: Partial<SessionV1.TextPart> = {}): SessionV1.TextPart {
  return {
    id: PartID.ascending(),
    sessionID: SessionID.descending(),
    messageID: MessageID.ascending(),
    type: "text",
    text,
    ...extra,
  }
}

function stampedPart(text: string, ranges?: ReadonlyArray<readonly [number, number]>, length = text.length) {
  return textPart(text, { metadata: JolliInput.stamped(undefined, { length, ...(ranges ? { ranges } : {}) }) })
}

/** The declaration a text part carries, as message-v2 reads it. */
const markOf = (part: SessionV1.TextPart) => JolliInput.marker(part.text, part.metadata)

const declared = (extra: Record<string, unknown> = {}) => ({ [JolliInput.OPTIONS_KEY]: { input: true, ...extra } })

function toolPart(state: SessionV1.ToolPart["state"], tool = "question"): SessionV1.ToolPart {
  return {
    id: PartID.ascending(),
    sessionID: SessionID.descending(),
    messageID: MessageID.ascending(),
    type: "tool",
    callID: "call-1",
    tool,
    state,
  }
}

/** A composer command's call, recorded in the student's name with its `command` argument stamped as theirs. */
function commandPart(command: string, metadata: Record<string, unknown> = {}): SessionV1.ToolPart {
  return toolPart(
    {
      status: "completed",
      input: { command },
      output: "ok",
      title: "",
      metadata: { ...metadata, ...JolliInput.studentCall({ command: { length: command.length } }) },
      time: { start: 1, end: 2 },
    },
    "bash",
  )
}

/** A model message's tool call recorded in the student's name, as message-v2 sends it to the Jolli gateway. */
const recordedCall = (input: Record<string, unknown>, call: Record<string, unknown>) => ({
  role: "assistant",
  content: [
    {
      type: "tool-call",
      toolCallId: "c",
      toolName: "bash",
      input,
      providerOptions: { [JolliInput.OPTIONS_KEY]: { call, recorded: true } },
    },
  ],
})

function completed(output: string, metadata: Record<string, unknown> = {}): SessionV1.ToolPart["state"] {
  return { status: "completed", input: {}, output, title: "Asked", metadata, time: { start: 1, end: 2 } }
}

describe("JolliInput.stamped", () => {
  test("replaces whatever a client put under the key, and keeps the rest of the metadata", () => {
    const forged = { [JolliInput.METADATA_KEY]: { length: 3, ranges: [] }, kind: "comment" }
    expect(JolliInput.stamped(forged, { length: 9 })).toEqual({
      kind: "comment",
      [JolliInput.METADATA_KEY]: { length: 9 },
    })
    expect(JolliInput.stamped(forged, undefined)).toEqual({ kind: "comment" })
    expect(JolliInput.stamped({ [JolliInput.METADATA_KEY]: { length: 3 } }, undefined)).toBeUndefined()
  })
})

describe("JolliInput.keepStamps", () => {
  test("keeps the server's stamp on text a client left alone, whatever the client sent under the key", () => {
    const stored = stampedPart("Write a greeting for Li Ming.", [[21, 28]])
    const forged = { ...stored, metadata: { [JolliInput.METADATA_KEY]: { length: 29, ranges: [] } } }
    expect(markOf(JolliInput.keepStamps(forged, stored, "user"))).toEqual({ input: true, ranges: [[21, 28]] })
    const unstamped = textPart("Called the Read tool", { synthetic: true })
    expect(markOf(JolliInput.keepStamps({ ...unstamped, ignored: true }, unstamped, "user"))).toBeUndefined()
  })

  test("declares the whole of a text a client changed or added", () => {
    const stored = stampedPart("Write a greeting for Li Ming.", [[21, 28]])
    expect(
      markOf(JolliInput.keepStamps({ ...stored, text: "Write a greeting for Wang Fang" }, stored, "user")),
    ).toEqual({ input: true })
    expect(markOf(JolliInput.keepStamps(textPart("written by a client"), undefined, "user"))).toEqual({ input: true })
  })

  test("never stamps a text outside a user message, the model's own reply however a client edits it", () => {
    const reply = textPart("Here is the fix.")
    const edited = JolliInput.keepStamps({ ...reply, text: "Here is the fix for Li Ming." }, reply, "assistant")
    expect(edited.metadata).toBeUndefined()
    const forged = { ...reply, metadata: { [JolliInput.METADATA_KEY]: { length: 16 } } }
    expect(JolliInput.keepStamps(forged, undefined, undefined).metadata).toBeUndefined()
  })

  test("keeps a tool result's stamp while its text is unchanged, and declares a rewritten one whole", () => {
    const stamp = { [JolliInput.METADATA_KEY]: { length: 9, ranges: [[3, 9]] } }
    const stored = toolPart(completed("Ok: Li Ming", stamp))
    const kept = JolliInput.keepStamps(toolPart(completed("Ok: Li Ming", { answers: [] })), stored, "assistant")
    expect(kept.state.status === "completed" && kept.state.metadata).toEqual({ answers: [], ...stamp })
    const rewritten = JolliInput.keepStamps(toolPart(completed("Ok: Wang Fang")), stored, "assistant")
    expect(rewritten.state.status === "completed" && rewritten.state.metadata).toEqual({
      [JolliInput.METADATA_KEY]: { length: 13 },
    })
  })

  test("keeps a refused call's feedback stamp when a client writes the error back without metadata", () => {
    const stamp = { [JolliInput.METADATA_KEY]: { length: 20, ranges: [[13, 20]] } }
    const failed = (metadata?: Record<string, unknown>): SessionV1.ToolPart["state"] => ({
      status: "error",
      input: {},
      error: "Refused: use Li Ming",
      ...(metadata ? { metadata } : {}),
      time: { start: 1, end: 2 },
    })
    const kept = JolliInput.keepStamps(toolPart(failed()), toolPart(failed(stamp)), "assistant")
    expect(kept.state.status === "error" && kept.state.metadata).toEqual(stamp)
  })

  test("keeps the stamps of a call's arguments the client left alone, and declares a rewritten one whole", () => {
    const stored = commandPart("grep Li notes")
    const kept = JolliInput.keepStamps(commandPart("grep Li notes", { forged: true }), stored, "assistant")
    expect(JolliInput.toolMarker(kept, undefined)).toEqual({ call: { command: {} }, recorded: true })
    const rewritten = JolliInput.keepStamps(
      toolPart({ ...stored.state, input: { command: "grep Wang notes" } } as SessionV1.ToolPart["state"], "bash"),
      stored,
      "assistant",
    )
    expect(rewritten.state.status === "completed" && rewritten.state.metadata[JolliInput.CALL_METADATA_KEY]).toEqual({
      command: { length: 15 },
    })
    expect(JolliInput.toolMarker(rewritten, undefined)).toEqual({ call: { command: {} }, recorded: true })
    const modelCall = toolPart(completed("ok"), "read")
    const unchanged = JolliInput.keepStamps(
      { ...modelCall, state: { ...modelCall.state, input: {} } },
      modelCall,
      "assistant",
    )
    expect(JolliInput.toolMarker(unchanged, undefined)).toBeUndefined()
  })

  test("declares an argument a client rewrote in the model's call, which stays the model's turn", () => {
    const modelCall = toolPart({ ...completed("ok"), input: { command: "ls" } }, "bash")
    const rewritten = JolliInput.keepStamps(
      { ...modelCall, state: { ...modelCall.state, input: { command: "grep 'Li Ming' notes" } } },
      modelCall,
      "assistant",
    )
    expect(JolliInput.toolMarker(rewritten, undefined)).toEqual({ call: { command: {} } })
    const message = { info: { role: "assistant" }, parts: [rewritten] } as unknown as SessionV1.WithParts
    expect(JolliInput.recordedForStudent(message)).toBe(false)
  })

  test("never lets a client mark a call as recorded in the student's name", () => {
    const modelCall = toolPart(completed("ok"), "bash")
    const forged = toolPart(completed("ok", { [JolliInput.RECORDED_METADATA_KEY]: true }), "bash")
    const kept = JolliInput.keepStamps(forged, modelCall, "assistant")
    expect(kept.state.status === "completed" && kept.state.metadata).toEqual({})
  })
})

describe("JolliInput.marker", () => {
  test("declares a part the server stamped, synthetic or not, and nothing it did not", () => {
    expect(markOf(stampedPart("fix the login page"))).toEqual({ input: true })
    expect(markOf({ ...stampedPart("a comment on a file"), synthetic: true })).toEqual({ input: true })
    expect(markOf(textPart("Called the Read tool", { synthetic: true }))).toBeUndefined()
    expect(markOf(textPart("written before stamping existed"))).toBeUndefined()
  })

  test("carries a command's argument ranges while they still describe its text", () => {
    expect(markOf(stampedPart("Write a greeting for Li Ming.", [[21, 28]]))).toEqual({
      input: true,
      ranges: [[21, 28]],
    })
    expect(markOf(stampedPart("Run the review.", []))).toEqual({ input: true, ranges: [] })
  })

  test("declares the whole block once its text no longer has the length its ranges were taken on", () => {
    expect(markOf(stampedPart("Rewritten by a plugin", [[0, 3]], 5))).toEqual({ input: true })
  })

  test("declares the whole block for ranges the server could not have recorded", () => {
    const text = "Write a greeting for Li Ming."
    expect(markOf(stampedPart(text, [[21, 40]]))).toEqual({ input: true })
    expect(
      markOf(
        stampedPart(text, [
          [21, 28],
          [6, 14],
        ]),
      ),
    ).toEqual({ input: true })
    expect(
      markOf(
        stampedPart(text, [
          [6, 14],
          [10, 20],
        ]),
      ),
    ).toEqual({ input: true })
    expect(markOf(stampedPart(text, [[5, 5]]))).toEqual({ input: true })
  })
})

describe("JolliInput.header", () => {
  test("hashes declared blocks in the desktop Node.js runtime without Bun globals", async () => {
    const bundle = await Bun.build({
      entrypoints: [fileURLToPath(new URL("../../src/session/jolli-input.ts", import.meta.url))],
      target: "node",
      format: "esm",
    })
    expect(bundle.success).toBe(true)
    const source = `data:text/javascript;base64,${Buffer.from(await bundle.outputs[0].text()).toString("base64")}`
    const prompt = [
      {
        role: "user",
        content: [{ type: "text", text: "now fix it", providerOptions: declared({ ranges: [[4, 7]] }) }],
      },
    ]
    const result = spawnSync("node", ["--input-type=module"], {
      input: `await import(${JSON.stringify(source)})
          .then(({ JolliInput }) => process.stdout.write(JolliInput.header(${JSON.stringify(prompt)})))
          .catch((error) => { console.error(error.message); process.exitCode = 1 })`,
      encoding: "utf8",
      timeout: 10_000,
    })
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`${sha256("now fix it")};4-7`)
  })

  test("hashes the declared blocks of the trailing user turn", () => {
    const value = JolliInput.header([
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: [{ type: "text", text: "earlier question", providerOptions: declared() }] },
      { role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "<file contents>" },
          { type: "text", text: "now fix it", providerOptions: declared() },
        ],
      },
      { role: "user", content: [{ type: "text", text: "and add a test", providerOptions: declared() }] },
    ])
    expect(value).toBe(`${sha256("now fix it")},${sha256("and add a test")}`)
  })

  test("reads the turn before a reply the request prefills, such as the step budget's closing note", () => {
    const value = JolliInput.header([
      { role: "user", content: [{ type: "text", text: "fix it in one step", providerOptions: declared() }] },
      { role: "assistant", content: [{ type: "text", text: MAX_STEPS_PROMPT }] },
    ])
    expect(value).toBe(sha256("fix it in one step"))
  })

  test("reads a request that ends with the model's own reply as answered", () => {
    const value = JolliInput.header([
      { role: "user", content: [{ type: "text", text: "fix it", providerOptions: declared() }] },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
    ])
    expect(value).toBe("none")
  })

  test("declares the arguments of calls recorded in the student's name, and reads past them to the turn before", () => {
    const value = JolliInput.header([
      { role: "user", content: [{ type: "text", text: "earlier", providerOptions: declared() }] },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
      { role: "user", content: [{ type: "text", text: "The following tool was executed by the user" }] },
      recordedCall({ command: "grep 'Li Ming' notes", description: "run" }, { command: {} }),
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c",
            toolName: "bash",
            output: { type: "text", value: "notes/a.md" },
            providerOptions: { [JolliInput.OPTIONS_KEY]: { call: { command: {} } } },
          },
        ],
      },
      recordedCall({ prompt: "Review Li Ming's essay" }, { prompt: { ranges: [[7, 14]] } }),
      { role: "user", content: [{ type: "text", text: "what now", providerOptions: declared() }] },
    ])
    expect(value).toBe(
      [sha256("grep 'Li Ming' notes"), `${sha256("Review Li Ming's essay")};7-14`, sha256("what now")].join(","),
    )
  })

  test("reads a call whose argument a client rewrote as the model's turn, declaring the argument with it", () => {
    const value = JolliInput.header([
      { role: "user", content: [{ type: "text", text: "earlier", providerOptions: declared() }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c",
            toolName: "bash",
            input: { command: "grep 'Li Ming' notes" },
            providerOptions: { [JolliInput.OPTIONS_KEY]: { call: { command: {} } } },
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "what now", providerOptions: declared() }] },
    ])
    expect(value).toBe(sha256("what now"))
  })

  test("reads past a reply a provider transform wrote, which is no turn of the model's", () => {
    const value = JolliInput.header([
      { role: "user", content: [{ type: "text", text: "earlier", providerOptions: declared() }] },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
      recordedCall({ command: "grep 'Li Ming' notes" }, { command: {} }),
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "c", toolName: "bash", output: { type: "text", value: "notes/a.md" } },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "Done." }], providerOptions: JolliInput.FILLER_OPTIONS },
      { role: "user", content: [{ type: "text", text: "what now", providerOptions: declared() }] },
    ])
    expect(value).toBe([sha256("grep 'Li Ming' notes"), sha256("what now")].join(","))
  })

  test("says none when the trailing turn holds nothing the student wrote", () => {
    expect(
      JolliInput.header([
        { role: "user", content: [{ type: "text", text: "question", providerOptions: declared() }] },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "read", input: {} }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "1", toolName: "read", output: "x" }] },
      ]),
    ).toBe("none")
    expect(
      JolliInput.header([
        { role: "user", content: [{ type: "text", text: "question", providerOptions: declared() }] },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "read", input: {} }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "1", toolName: "read", output: "x" }] },
        { role: "assistant", content: MAX_STEPS_PROMPT },
      ]),
    ).toBe("none")
    expect(JolliInput.header([{ role: "user", content: "a bare prompt" }])).toBe("none")
  })

  test("declares what the student typed into the trailing turn's tool results", () => {
    const answer = 'User has answered your questions: "Who?"="Li Ming".'
    const value = JolliInput.header([
      { role: "user", content: [{ type: "text", text: "ask me", providerOptions: declared() }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "question", input: {} }] },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "1",
            toolName: "question",
            output: { type: "text", value: answer },
            providerOptions: declared({ ranges: [[42, 49]] }),
          },
          {
            type: "tool-result",
            toolCallId: "2",
            toolName: "read",
            output: { type: "text", value: "file body" },
          },
        ],
      },
    ])
    expect(value).toBe(`${sha256(answer)};42-49`)
  })

  test("declares a whole block whose ranges nothing here could have recorded", () => {
    const value = JolliInput.header([
      {
        role: "user",
        content: [{ type: "text", text: "Write a greeting", providerOptions: declared({ ranges: [[9, 3]] }) }],
      },
    ])
    expect(value).toBe(sha256("Write a greeting"))
  })

  test("sends a command block's argument ranges, and leaves out one with no arguments", () => {
    const value = JolliInput.header([
      {
        role: "user",
        content: [
          { type: "text", text: "Write a greeting for Li Ming.", providerOptions: declared({ ranges: [[21, 28]] }) },
          { type: "text", text: "Run the review.", providerOptions: declared({ ranges: [] }) },
        ],
      },
    ])
    expect(value).toBe(`${sha256("Write a greeting for Li Ming.")};21-28`)
  })
})

describe("JolliInput.toolMarker", () => {
  test("declares a stamped result's ranges and a stamped argument by name, only while each still fits", () => {
    const part = commandPart("grep Li notes", { [JolliInput.METADATA_KEY]: { length: 2, ranges: [[0, 1]] } })
    expect(JolliInput.toolMarker(part, "ok")).toEqual({
      input: true,
      ranges: [[0, 1]],
      call: { command: {} },
      recorded: true,
    })
    const rewritten = { ...part, state: { ...part.state, input: { command: "grep Wang notes" } } } as SessionV1.ToolPart
    expect(JolliInput.toolMarker(rewritten, undefined)).toEqual({ call: { command: {} }, recorded: true })
    expect(JolliInput.toolMarker(toolPart(completed("ok")), "ok")).toBeUndefined()
  })

  test("declares of a result sent cut short only what is left of the student's words, and nothing of one cleared", () => {
    const output = 'User has answered your questions: "Whose essay?"="Li Ming".'
    const answer = output.indexOf("Li Ming")
    const part = toolPart(
      completed(output, { [JolliInput.METADATA_KEY]: { length: output.length, ranges: [[answer, answer + 7]] } }),
    )
    expect(JolliInput.toolMarker(part, `${output.slice(0, answer + 2)}\n[truncated]`)).toEqual({
      input: true,
      ranges: [[answer, answer + 2]],
    })
    expect(JolliInput.toolMarker(part, `${output.slice(0, answer)}\n[truncated]`)).toBeUndefined()
    expect(JolliInput.toolMarker(part, "[Old tool result content cleared]")).toBeUndefined()
  })
})

describe("JolliInput.recordedForStudent", () => {
  const message = (parts: SessionV1.Part[], role: "user" | "assistant" = "assistant") =>
    ({ info: { role }, parts }) as unknown as SessionV1.WithParts

  test("tells a call recorded in the student's name from a turn of the model's", () => {
    expect(JolliInput.recordedForStudent(message([commandPart("ls")]))).toBe(true)
    expect(JolliInput.recordedForStudent(message([commandPart("ls"), textPart("and then")]))).toBe(false)
    expect(JolliInput.recordedForStudent(message([toolPart(completed("ok"))]))).toBe(false)
    expect(JolliInput.recordedForStudent(message([]))).toBe(false)
    expect(JolliInput.recordedForStudent(message([commandPart("ls")], "user"))).toBe(false)
  })
})

describe("JolliInput.spans", () => {
  test("gives a stamped text's ranges, its whole length, or nothing", () => {
    expect(JolliInput.spans("Greet Li Ming", JolliInput.stamped(undefined, { length: 13, ranges: [[6, 13]] }))).toEqual(
      [[6, 13]],
    )
    expect(JolliInput.spans("Greet Li Ming", JolliInput.stamped(undefined, { length: 13 }))).toEqual([[0, 13]])
    expect(JolliInput.spans("Greet Li Ming", undefined)).toEqual([])
  })
})
