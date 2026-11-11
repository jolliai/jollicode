import { voiceWav } from "./voice-wav"
import { createStore } from "solid-js/store"
import { onCleanup } from "solid-js"
import { Option, Schema } from "effect"
import type { Jolli } from "@opencode-ai/schema/jolli"
import type { ServerSDK } from "@/context/server-sdk"
import { groupChatFetch } from "./group-chat-media"

type VoiceHolder = { sessionId: string; stop: () => void; release: (sessionId: string) => Promise<unknown> }

/**
 * One voice activity app-wide, each under a server voice session of its own. The server tombstones a
 * released session id for ten minutes, so an id is never claimed twice; each is released exactly once,
 * and the next activity waits briefly for earlier releases so the server sees the old lock go first.
 */
export function createVoiceSessions(fresh: () => string = () => crypto.randomUUID(), wait = 2000) {
  let holder: VoiceHolder | undefined
  const released = new Set<string>()
  let pending: Promise<unknown> = Promise.resolve()
  const send = (sessionId: string, release: VoiceHolder["release"]) => {
    if (released.has(sessionId)) return
    released.add(sessionId)
    pending = Promise.all([pending, release(sessionId).catch(() => undefined)])
  }
  return {
    /** Ends whatever activity holds voice now, then starts one under a fresh session id. */
    claim(stop: () => void, release: VoiceHolder["release"]) {
      const previous = holder
      holder = undefined
      if (previous) {
        previous.stop()
        send(previous.sessionId, previous.release)
      }
      const sessionId = fresh()
      holder = { sessionId, stop, release }
      return sessionId
    },
    release(sessionId: string, release: VoiceHolder["release"]) {
      if (holder?.sessionId === sessionId) holder = undefined
      send(sessionId, release)
    },
    holds: (sessionId: string) => holder?.sessionId === sessionId,
    settled() {
      let timer: ReturnType<typeof setTimeout> | undefined
      const bound = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, wait)
      })
      return Promise.race([pending.then(() => undefined), bound]).finally(() => clearTimeout(timer))
    },
  }
}

const sessions = createVoiceSessions()

const VoiceError = Schema.Struct({ code: Schema.String })

export function useGroupChatVoice(input: {
  sdk: () => ServerSDK
  id: () => Jolli.GroupChatID
  locale: () => string
  append: (text: string) => void
}) {
  const [state, setState] = createStore<{
    mode: "idle" | "recording" | "transcribing" | "playing"
    error?: "permission" | "failed" | "refresh"
    playingId?: number
  }>({ mode: "idle" })
  /** The voice session of this page's current activity; empty while it holds none. */
  let activity: string | undefined
  let abort = new AbortController()
  let media: MediaStream | undefined
  let context: AudioContext | undefined
  let processor: ScriptProcessorNode | undefined
  let clock: ReturnType<typeof setTimeout> | undefined
  let audio: HTMLAudioElement | undefined
  let url: string | undefined
  let chunks: Float32Array[] = []
  let disposed = false
  let generation = 0
  const query = () => `?chatID=${encodeURIComponent(input.id())}`
  const headers = (sessionId: string, requestId = crypto.randomUUID()) => ({
    "X-Request-Id": requestId,
    "X-Voice-Session": sessionId,
    "X-Voice-Locale": input.locale().toLowerCase().startsWith("es") ? "es" : "en",
  })
  const release = (sessionId: string) =>
    groupChatFetch(input.sdk(), `/jolli/voice/session${query()}`, { method: "DELETE", headers: headers(sessionId) })
  const clearRecording = async () => {
    clearTimeout(clock)
    processor?.disconnect()
    processor = undefined
    media?.getTracks().forEach((track) => track.stop())
    media = undefined
    await context?.close().catch(() => undefined)
    context = undefined
  }
  /** Stops this page's local voice work without touching the server session. */
  const end = () => {
    generation++
    abort.abort()
    abort = new AbortController()
    void clearRecording()
    audio?.pause()
    audio = undefined
    if (url) URL.revokeObjectURL(url)
    url = undefined
    chunks = []
    setState({ mode: "idle", playingId: undefined })
  }
  const stop = async () => {
    end()
    const sessionId = activity
    activity = undefined
    if (sessionId) sessions.release(sessionId, release)
  }
  const acquire = async () => {
    await stop()
    const sessionId = sessions.claim(() => {
      end()
      activity = undefined
    }, release)
    activity = sessionId
    setState("error", undefined)
    const run = generation
    await sessions.settled()
    return { run, sessionId }
  }
  const current = (run: number, sessionId: string) => !disposed && generation === run && activity === sessionId
  const finish = async () => {
    const sessionId = activity
    if (state.mode !== "recording" || !sessionId) return
    if (!media || !context) {
      await stop()
      return
    }
    const rate = context.sampleRate
    await clearRecording()
    setState("mode", "transcribing")
    const requestId = crypto.randomUUID()
    const signal = abort.signal
    const run = generation
    const body = voiceWav(chunks, rate)
    chunks = []
    const text = await (async () => {
      let response = await groupChatFetch(input.sdk(), `/jolli/voice/transcription${query()}`, {
        method: "POST",
        headers: { ...headers(sessionId, requestId), "Content-Type": "audio/wav" },
        body,
        signal,
      })
      while (response.status === 202 && !signal.aborted) {
        const delay = Math.min(5000, Math.max(500, Number(response.headers.get("retry-after") ?? 1) * 1000))
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay)
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer)
              resolve()
            },
            { once: true },
          )
        })
        response = await groupChatFetch(input.sdk(), `/jolli/voice/transcription/${requestId}${query()}`, {
          headers: headers(sessionId, requestId),
          signal,
        })
      }
      if (!response.ok) return undefined
      return Option.getOrUndefined(
        Schema.decodeUnknownOption(Schema.Struct({ text: Schema.String }))(await response.json()),
      )?.text
    })().catch(() => undefined)
    if (current(run, sessionId) && !signal.aborted) {
      if (text === undefined) setState("error", "failed")
      else input.append(text)
    }
    if (run === generation) await stop()
  }
  onCleanup(() => {
    disposed = true
    void stop()
  })
  return {
    state,
    stop,
    finish,
    async record() {
      const lease = await acquire()
      if (!current(lease.run, lease.sessionId)) return
      setState("mode", "recording")
      const stream = await navigator.mediaDevices
        .getUserMedia({ audio: { channelCount: 1, echoCancellation: true }, video: false })
        .catch((error: unknown) => error)
      if (!(stream instanceof MediaStream)) {
        if (!current(lease.run, lease.sessionId)) return
        await stop()
        setState("error", stream instanceof DOMException && stream.name === "NotAllowedError" ? "permission" : "failed")
        return
      }
      if (!current(lease.run, lease.sessionId)) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      media = stream
      context = new AudioContext({ sampleRate: 16000 })
      processor = context.createScriptProcessor(4096, 1, 1)
      chunks = []
      processor.onaudioprocess = (event) => chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)))
      context.createMediaStreamSource(media).connect(processor)
      processor.connect(context.destination)
      clock = setTimeout(() => void finish(), 119_000)
    },
    async play(messageId: number) {
      const lease = await acquire()
      if (!current(lease.run, lease.sessionId)) return
      const signal = abort.signal
      setState({ mode: "playing", playingId: messageId })
      let version: string | undefined
      let count = 1
      let outcome: "done" | "failed" | "refresh" = "done"
      for (let segment = 0; segment < count && current(lease.run, lease.sessionId) && !signal.aborted; segment++) {
        const response = await groupChatFetch(input.sdk(), `/jolli/voice/read-aloud${query()}`, {
          method: "POST",
          headers: { ...headers(lease.sessionId), "Content-Type": "application/json" },
          body: JSON.stringify({ messageId, segment, ...(version ? { narrationVersion: version } : {}) }),
          signal,
        }).catch(() => undefined)
        if (!response?.ok) {
          const refused = response
            ? Option.getOrUndefined(
                Schema.decodeUnknownOption(VoiceError)(await response.json().catch(() => undefined)),
              )
            : undefined
          outcome = refused?.code === "refresh_required" ? "refresh" : "failed"
          break
        }
        if (segment === 0) {
          version = response.headers.get("x-voice-narration-version") ?? undefined
          count = Number(response.headers.get("x-voice-segment-count"))
          if (!version || !Number.isSafeInteger(count) || count < 1 || count > 500) {
            outcome = "failed"
            break
          }
        }
        const blob = await response.blob().catch(() => undefined)
        if (!blob) {
          outcome = "failed"
          break
        }
        url = URL.createObjectURL(blob)
        const player = new Audio(url)
        audio = player
        const played = await new Promise<boolean>((resolve) => {
          const cancel = () => {
            player.pause()
            resolve(true)
          }
          signal.addEventListener("abort", cancel, { once: true })
          player.onended = () => {
            signal.removeEventListener("abort", cancel)
            resolve(true)
          }
          player.onerror = () => resolve(false)
          void player.play().catch(() => resolve(false))
        })
        URL.revokeObjectURL(url)
        url = undefined
        if (!played) {
          outcome = "failed"
          break
        }
      }
      // A changed narration stops for good: version and count are dropped and nothing restarts by itself.
      if (outcome !== "done" && current(lease.run, lease.sessionId) && !signal.aborted) setState("error", outcome)
      if (lease.run === generation) await stop()
    },
    dispose() {
      disposed = true
      void stop()
    },
  }
}
