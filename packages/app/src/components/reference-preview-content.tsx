import { createEffect, createResource, For, Match, onCleanup, Show, Switch, ErrorBoundary } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { Icon } from "@opencode-ai/ui/icon"
import { Schema } from "effect"
import type { Jolli } from "@opencode-ai/schema/jolli"
import type { ServerSDK } from "@/context/server-sdk"
import { useLanguage } from "@/context/language"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { useConfirmation, useExternalLinkConfirm } from "./external-link-confirm"
import { ReferenceFileViewer } from "./reference-file-viewer"
import { ReferenceMarkdown } from "./reference-markdown"
import { ReferenceMindMapViewer } from "./reference-mindmap-viewer"
import { jsonRecord } from "@/jolli/reference-mindmap"
import {
  readReference,
  ReferenceSignedOutError,
  ReferenceMaterial,
  ReferenceAssignment,
  ReferenceArtifact,
  ReferencePlan,
  referenceFileMime,
  referenceCourseTarget,
  type ReferencePreview,
} from "@/jolli/reference-preview"
import { safeReferenceUrl } from "@/jolli/external-link"
import { assignmentReferenceStatus } from "@/jolli/reference-assignment-status"
import { downloadChatFile } from "@/jolli/reference-download"
import { showToast } from "@/utils/toast"

type ReaderProps = {
  sdk: ServerSDK
  target: Jolli.ReferenceTarget
  item: ReferencePreview
  onOpen: (item: ReferencePreview) => void
  /** A read answered that the credential is gone; the window drops the server's chats, this pane with them. */
  onSignedOut: () => void
  actions?: HTMLElement
}

/** One read of the reference a reader shows. */
function readShown(props: ReaderProps, operation: Jolli.ReferenceRequest["operation"], signal?: AbortSignal) {
  return readReference(props.sdk, props.target, props.item.reference, operation, signal).catch((error: unknown) => {
    if (error instanceof ReferenceSignedOutError) props.onSignedOut()
    throw error
  })
}

export function ReferencePreviewContent(props: ReaderProps) {
  const language = useLanguage()
  const abort = new AbortController()
  onCleanup(() => abort.abort())
  const [resource, { refetch }] = createResource(
    () => props.item.key,
    () => readShown(props, "read", abort.signal),
  )
  let checks = 0
  createEffect(() => {
    if (resource.error || resource.loading) return
    const value = jsonRecord(resource())
    const phase = jsonRecord(value?.map)?.phase
    const latest = jsonRecord(value?.latestVersion)?.status
    const pending =
      value?.state === "pending" ||
      phase === "reading" ||
      (props.item.reference.kind === "artifact" &&
        value?.currentVersion === null &&
        (latest === "queued" || latest === "generating"))
    if (!pending) return
    const ask = () => {
      if (!document.hidden) void refetch()
    }
    const timer = setTimeout(
      () => {
        if (document.hidden) return document.addEventListener("visibilitychange", ask, { once: true })
        ask()
      },
      Math.min(1200 * 2 ** checks++, 10000),
    )
    onCleanup(() => {
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", ask)
    })
  })
  return (
    <ErrorBoundary
      fallback={(_error, reset) => (
        <ReferenceFailure
          retry={() => {
            void Promise.resolve(refetch()).finally(reset)
          }}
        />
      )}
    >
      <Show
        when={!resource.loading}
        fallback={
          <p class="reference-notice" role="status">
            {language.t("groupChat.preview.loading")}
          </p>
        }
      >
        <Show
          when={!resource.error && resource() !== undefined}
          fallback={<ReferenceFailure retry={() => void refetch()} />}
        >
          <Switch>
            <Match when={props.item.reference.kind === "material"}>
              <MaterialReferenceContent {...props} material={Schema.decodeUnknownSync(ReferenceMaterial)(resource())} />
            </Match>
            <Match when={props.item.reference.kind === "assignment"}>
              <AssignmentReferenceContent
                {...props}
                assignment={Schema.decodeUnknownSync(ReferenceAssignment)(resource())}
              />
            </Match>
            <Match when={props.item.reference.kind === "artifact"}>
              <StudioReferenceContent {...props} artifact={Schema.decodeUnknownSync(ReferenceArtifact)(resource())} />
            </Match>
            <Match when={props.item.reference.kind === "attachment"}>
              <AttachmentReferenceContent {...props} attachment={resource()} />
            </Match>
            <Match when={props.item.reference.kind === "assignmentDoc"}>
              <div class="reference-markdown">
                <Markdown
                  text={Schema.decodeUnknownSync(Schema.Struct({ markdown: Schema.String }))(resource()).markdown}
                  untrusted
                />
              </div>
            </Match>
            <Match when={props.item.reference.kind === "assignmentFile"}>
              <AssignmentFileReferenceContent
                {...props}
                address={Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(resource()).url}
              />
            </Match>
          </Switch>
        </Show>
      </Show>
    </ErrorBoundary>
  )
}

function MaterialReferenceContent(props: ReaderProps & { material: ReferenceMaterial }) {
  const language = useLanguage()
  const openLink = useExternalLinkConfirm()
  const artifact = () => (props.material.url ? props.material.artifact : undefined)
  return (
    <Switch>
      <Match when={artifact()}>
        {(entry) => (
          <ReferencePreviewContent
            {...props}
            item={{
              key: `artifact:${entry().id}`,
              title: props.material.title,
              reference: { kind: "artifact", artifactId: entry().id, version: entry().version },
            }}
          />
        )}
      </Match>
      <Match when={props.material.notOnSite}>
        <div class="reference-markdown">
          <p class="reference-notice">{language.t("groupChat.preview.savedCopy")}</p>
          <Markdown text={props.material.notOnSite?.text ?? ""} untrusted />
        </div>
      </Match>
      <Match when={props.material.state || !props.material.url}>
        <p class="reference-notice">
          {language.t(
            props.material.state === "pending" ? "groupChat.preview.preparing" : "groupChat.preview.unavailable",
          )}
        </p>
      </Match>
      <Match when={props.material.map}>
        <Show
          when={props.material.map?.phase === "done"}
          fallback={
            <p class="reference-notice">
              {language.t(
                props.material.map?.phase === "reading" ? "groupChat.preview.preparing" : "groupChat.preview.failed",
              )}
            </p>
          }
        >
          <MindMapReferenceContent {...props} />
        </Show>
      </Match>
      <Match when={props.material.webPage}>
        <ReferencePageFrame
          title={props.material.title}
          first={props.material.webPage?.url}
          renew={async () =>
            Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(await readShown(props, "page")).url
          }
        />
      </Match>
      <Match when={props.material.origin === "link" && !props.material.storedCopy}>
        <button
          class="reference-action"
          type="button"
          onClick={() => {
            if (props.material.url) void openLink(props.material.url)
          }}
        >
          {language.t("groupChat.preview.openOriginal")}
        </button>
      </Match>
      <Match when={props.material.url}>
        <div class="reference-material-file">
          <Show when={props.material.origin !== "link"}>
            <ReferenceDownload
              url={props.material.url!}
              filename={props.material.title}
              mimeType={props.material.mimeType}
              mount={props.actions}
            />
          </Show>
          <ReferenceFileViewer
            url={props.material.url!}
            title={props.material.title}
            mimeType={props.material.mimeType}
            sizeBytes={props.material.sizeBytes}
            locator={props.item.locator}
          />
        </div>
      </Match>
    </Switch>
  )
}

function AssignmentReferenceContent(props: ReaderProps & { assignment: typeof ReferenceAssignment.Type }) {
  const language = useLanguage()
  let host: HTMLDivElement | undefined
  createEffect(() => {
    const taskId = props.item.taskId
    if (taskId)
      queueMicrotask(() => host?.querySelector(`[data-task-id="${taskId}"]`)?.scrollIntoView({ block: "start" }))
  })
  return (
    <div ref={host} class="reference-assignment reference-markdown">
      <h2>{props.assignment.title}</h2>
      <p>{props.assignment.description}</p>
      <Show when={props.assignment.dueAt}>
        <p class="reference-notice">
          {language.t("groupChat.preview.due", {
            date: new Date(props.assignment.dueAt!).toLocaleString(language.intl()),
          })}
        </p>
      </Show>
      <ReferenceMarkdown text={props.assignment.worksheet} locator={props.item.locator} />
      <Show
        when={
          props.item.citedSource?.category === "submission" &&
          assignmentReferenceStatus(props.assignment, props.item.citedSource.sourceId, props.item.taskId) === "changed"
        }
      >
        <p class="reference-notice" role="note">
          {language.t("groupChat.preview.submissionChanged")}
        </p>
      </Show>
      <Show when={props.assignment.overallComment}>
        <h3>{language.t("session.sources.feedback")}</h3>
        <Markdown text={props.assignment.overallComment ?? ""} untrusted />
      </Show>
      <div class="reference-task-list">
        <For each={props.assignment.parts}>
          {(task) => (
            <section class="reference-task" data-task-id={task.id} tabIndex={-1}>
              <h3>
                {language.t("dialog.assignment.task.title", { number: task.position + 1 })} · {task.name}
              </h3>
              <Show when={task.reflectionPrompt}>
                <Markdown text={task.reflectionPrompt ?? ""} untrusted />
              </Show>
              <Show when={task.assistantBlurb}>
                <p>{task.assistantBlurb}</p>
              </Show>
              <Show when={task.submission?.summary}>
                <h4>{language.t("session.sources.submission")}</h4>
                <Markdown text={task.submission?.summary ?? ""} untrusted />
              </Show>
              <Show when={task.submission?.reflection}>
                <h4>{language.t("session.sources.reflection")}</h4>
                <Markdown text={task.submission?.reflection ?? ""} untrusted />
              </Show>
              <Show when={task.submission?.staffComment ?? task.lastReviewComment}>
                <h4>{language.t("session.sources.feedback")}</h4>
                <Markdown text={task.submission?.staffComment ?? task.lastReviewComment ?? ""} untrusted />
              </Show>
              <For
                each={[
                  ...(task.submission?.files ?? []),
                  ...(task.files ?? []).filter(
                    (file) => !task.submission?.files?.some((submitted) => submitted.id === file.id),
                  ),
                ]}
              >
                {(file) => (
                  <button
                    type="button"
                    class="reference-action"
                    disabled={file.status !== "ready"}
                    onClick={() =>
                      props.onOpen({
                        key: `assignment-file:${props.assignment.id}:${task.id}:${file.id}`,
                        title: file.filename,
                        mimeType: referenceFileMime(file.filename),
                        webPage: file.webPage,
                        reference: {
                          kind: "assignmentFile",
                          courseId: props.assignment.courseId,
                          assignmentId: props.assignment.id,
                          taskId: task.id,
                          fileId: file.id,
                        },
                      })
                    }
                  >
                    {file.filename}
                  </button>
                )}
              </For>
              <For each={task.submission?.docs ?? []}>
                {(doc) => (
                  <button
                    type="button"
                    class="reference-action"
                    onClick={() => {
                      if (doc.position === undefined) return
                      props.onOpen({
                        key: `assignment-doc:${props.assignment.id}:${task.id}:submitted:${doc.position}`,
                        title: doc.name,
                        reference: {
                          kind: "assignmentDoc",
                          courseId: props.assignment.courseId,
                          assignmentId: props.assignment.id,
                          taskId: task.id,
                          docId: doc.position,
                          submitted: true,
                        },
                      })
                    }}
                  >
                    {doc.name}
                  </button>
                )}
              </For>
              <For each={task.docs ?? []}>
                {(doc) => (
                  <button
                    type="button"
                    class="reference-action"
                    onClick={() => {
                      if (doc.id === undefined) return
                      props.onOpen({
                        key: `assignment-doc:${props.assignment.id}:${task.id}:${doc.id}`,
                        title: doc.name,
                        reference: {
                          kind: "assignmentDoc",
                          courseId: props.assignment.courseId,
                          assignmentId: props.assignment.id,
                          taskId: task.id,
                          docId: doc.id,
                          submitted: false,
                        },
                      })
                    }}
                  >
                    {doc.name}
                  </button>
                )}
              </For>
            </section>
          )}
        </For>
      </div>
    </div>
  )
}

function ReferenceDownload(props: { url: string; filename: string; mimeType?: string | null; mount?: HTMLElement }) {
  const language = useLanguage()
  const confirm = useConfirmation()
  const [state, setState] = createStore({ busy: false })
  // Ended with the preview, which the chat page closes when the reader loses the chat or the account
  // resets: a file still on its way is then neither confirmed nor saved.
  const abort = new AbortController()
  onCleanup(() => abort.abort())
  return (
    <Show when={props.mount}>
      {(mount) => (
        <Portal mount={mount()}>
          <button
            type="button"
            class="reference-icon-button reference-download-button"
            aria-label={language.t("groupChat.preview.download")}
            title={language.t("groupChat.preview.download")}
            disabled={state.busy}
            aria-busy={state.busy}
            onClick={() => {
              if (state.busy) return
              setState("busy", true)
              void downloadChatFile({
                source: props.url,
                filename: props.filename,
                mimeType: props.mimeType,
                allowExecutable: () =>
                  confirm({
                    title: language.t("groupChat.preview.download"),
                    detail: language.t("groupChat.unsafeFile"),
                    confirm: language.t("groupChat.preview.download"),
                  }),
                signal: abort.signal,
              })
                .catch(() => showToast({ title: language.t("groupChat.preview.downloadFailed"), variant: "error" }))
                .finally(() => setState("busy", false))
            }}
          >
            <Icon name="download" size="small" />
          </button>
        </Portal>
      )}
    </Show>
  )
}

function AssignmentFileReferenceContent(props: ReaderProps & { address: string }) {
  return (
    <div class="reference-material-file">
      <ReferenceDownload
        url={props.address}
        filename={props.item.title}
        mimeType={props.item.mimeType}
        mount={props.actions}
      />
      <Show
        when={props.item.webPage}
        fallback={
          <ReferenceFileViewer
            url={props.address}
            title={props.item.title}
            mimeType={props.item.mimeType ?? referenceFileMime(props.item.title)}
          />
        }
      >
        <ReferencePageFrame
          title={props.item.title}
          renew={async () =>
            Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(await readShown(props, "page")).url
          }
        />
      </Show>
    </div>
  )
}

function StudioReferenceContent(props: ReaderProps & { artifact: typeof ReferenceArtifact.Type }) {
  const language = useLanguage()
  const kinds = {
    study_guide: "groupChat.preview.study_guide",
    practice_quiz: "groupChat.preview.practice_quiz",
    flashcards: "groupChat.preview.flashcards",
    lesson_plan: "groupChat.preview.lesson_plan",
    simulation: "groupChat.preview.simulation",
  } as const
  const kindLabel = () => {
    const kind = props.artifact.kind
    return language.t(
      kind === "study_guide" ||
        kind === "practice_quiz" ||
        kind === "flashcards" ||
        kind === "lesson_plan" ||
        kind === "simulation"
        ? kinds[kind]
        : "groupChat.preview.artifact",
    )
  }
  return (
    <Show
      when={props.artifact.currentVersion !== null}
      fallback={
        <p class="reference-notice" role="status">
          {language.t(
            props.artifact.latestVersion?.status === "failed"
              ? "groupChat.preview.failed"
              : "groupChat.preview.preparing",
          )}
        </p>
      }
    >
      <Switch>
        <Match when={props.artifact.kind === "course_plan"}>
          <CoursePlanReferenceContent {...props} />
        </Match>
        <Match when={props.artifact.kind !== "course_plan"}>
          <div class="reference-studio" data-testid="studio-artifact-preview">
            <p class="reference-kind">{kindLabel()}</p>
            <ReferencePageFrame
              title={props.artifact.title}
              studio
              renew={async () =>
                Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(await readShown(props, "page")).url
              }
            />
          </div>
        </Match>
      </Switch>
    </Show>
  )
}

function CoursePlanReferenceContent(props: ReaderProps) {
  const language = useLanguage()
  const openLink = useExternalLinkConfirm()
  const abort = new AbortController()
  onCleanup(() => abort.abort())
  const [plan] = createResource(async () =>
    Schema.decodeUnknownSync(ReferencePlan)(await readShown(props, "plan", abort.signal)),
  )
  return (
    <Show
      when={plan()}
      fallback={
        <p class="reference-notice">
          {language.t(plan.error ? "groupChat.preview.failed" : "groupChat.preview.loading")}
        </p>
      }
    >
      {(document) => (
        <article class="reference-markdown reference-course-plan">
          <p class="reference-kind">
            {language.t("groupChat.preview.course_plan")} ·{" "}
            {language.t("groupChat.preview.version", { version: document().version })}
          </p>
          <h2>{document().title}</h2>
          <Markdown text={document().plan.summary} untrusted />
          <h3>{language.t("groupChat.agents")}</h3>
          <For each={document().plan.agents}>
            {(agent) => (
              <details class="reference-task">
                <summary>{agent.name}</summary>
                <Markdown text={agent.brief} untrusted />
                <PlanAgentSettings agent={agent} materials={document().plan.materials} />
              </details>
            )}
          </For>
          <h3>{language.t("session.sources.assignmentGroup")}</h3>
          <For each={document().plan.assignments}>
            {(assignment) => (
              <details class="reference-task" open>
                <summary>{assignment.title}</summary>
                <p>{assignment.description}</p>
                <PlanTiming value={assignment.opens} label={language.t("groupChat.preview.opensAt")} />
                <PlanTiming value={assignment.due} label={language.t("groupChat.preview.dueAt")} />
                <PlanGrading value={assignment.grading} />
                <Markdown text={assignment.worksheet} untrusted />
                <For each={assignment.tasks}>{(task) => <PlanTask task={task} />}</For>
              </details>
            )}
          </For>
          <Show when={document().plan.materials.length}>
            <h3>{language.t("session.sources.materials")}</h3>
            <For each={document().plan.materials}>
              {(material) => {
                const value = jsonRecord(material)
                const ref = jsonRecord(value?.ref)
                const title = stringOf(ref?.titleAtPlanning)
                const reference: Jolli.Reference | undefined =
                  ref?.kind === "material" && typeof ref.materialId === "number"
                    ? { kind: "material", materialId: ref.materialId }
                    : ref?.kind === "artifact" && typeof ref.artifactId === "string"
                      ? { kind: "artifact", artifactId: ref.artifactId }
                      : undefined
                return (
                  <section class="reference-task">
                    <button
                      type="button"
                      class="reference-action"
                      disabled={!reference}
                      onClick={() => {
                        if (reference)
                          props.onOpen({
                            target: referenceCourseTarget(props.target, document().courseId),
                            key: `plan-material:${stringOf(value?.id)}`,
                            title,
                            reference,
                          })
                      }}
                    >
                      {title}
                    </button>
                    <p class="reference-kind">
                      {language.t(
                        value?.studentAccess === "download"
                          ? "groupChat.preview.studentAccess"
                          : "groupChat.preview.agentsOnly",
                      )}
                    </p>
                    <Show when={typeof value?.reason === "string"}>
                      <Markdown text={stringOf(value?.reason)} untrusted />
                    </Show>
                  </section>
                )
              }}
            </For>
          </Show>
          <Show when={document().plan.notes?.length}>
            <h3>{language.t("groupChat.preview.notes")}</h3>
            <For each={document().plan.notes ?? []}>
              {(note) => (
                <Markdown text={typeof note === "string" ? note : stringOf(jsonRecord(note)?.text)} untrusted />
              )}
            </For>
          </Show>
          <h3>{language.t("session.sources.references")}</h3>
          <For each={document().sources}>
            {(source) => (
              <button
                type="button"
                class="reference-action"
                disabled={source.kind === "web" && !safeReferenceUrl(String(source.id))}
                onClick={() => {
                  if (source.kind === "web") {
                    void openLink(String(source.id))
                    return
                  }
                  const reference: Jolli.Reference | undefined =
                    source.kind === "material" && typeof source.id === "number"
                      ? { kind: "material", materialId: source.id }
                      : source.kind === "assignment" && typeof source.id === "number"
                        ? {
                            kind: "assignment",
                            courseId: document().courseId,
                            assignmentId: source.id,
                            staffView: true,
                          }
                        : source.kind === "artifact" && typeof source.id === "string"
                          ? { kind: "artifact", artifactId: source.id }
                          : undefined
                  if (reference)
                    props.onOpen({
                      target: referenceCourseTarget(props.target, document().courseId),
                      key: `${source.kind}:${source.id}`,
                      title: source.title,
                      reference,
                    })
                }}
              >
                {source.title}
              </button>
            )}
          </For>
        </article>
      )}
    </Show>
  )
}

function PlanAgentSettings(props: {
  agent: (typeof ReferencePlan.Type.plan.agents)[number]
  materials: readonly Schema.Json[]
}) {
  const language = useLanguage()
  const flags = () => jsonRecord(props.agent.guardrails)
  const models = () => jsonRecord(props.agent.models)
  const context = () => jsonRecord(props.agent.contextMaterials)
  const materialIds = () => {
    const value = context()?.materialIds
    return Array.isArray(value) ? value : []
  }
  const titles = () =>
    props.materials
      .flatMap((material) => {
        const data = jsonRecord(material)
        const ref = jsonRecord(data?.ref)
        return materialIds().includes(data?.id ?? null) ? [stringOf(ref?.titleAtPlanning)] : []
      })
      .filter(Boolean)
      .join(", ")
  const settings = [
    { key: "socraticMode", label: "groupChat.preview.socratic" },
    { key: "restrictToMaterials", label: "groupChat.preview.restrictMaterials" },
    { key: "restrictToCourseTopic", label: "groupChat.preview.restrictTopic" },
    { key: "showCitations", label: "groupChat.preview.citations" },
  ] as const
  return (
    <div class="reference-plan-settings">
      <dl>
        <dt>{language.t("groupChat.preview.model")}</dt>
        <dd>{stringOf(models()?.defaultModel) || language.t("groupChat.preview.courseDefault")}</dd>
        <dt>{language.t("groupChat.preview.includeAssignments")}</dt>
        <dd>{language.t(props.agent.includeAssignments ? "groupChat.preview.on" : "groupChat.preview.off")}</dd>
        <For each={settings}>
          {(setting) => (
            <Show when={typeof flags()?.[setting.key] === "boolean"}>
              <dt>{language.t(setting.label)}</dt>
              <dd>{language.t(flags()?.[setting.key] ? "groupChat.preview.on" : "groupChat.preview.off")}</dd>
            </Show>
          )}
        </For>
        <Show when={titles()}>
          <dt>{language.t("session.sources.materials")}</dt>
          <dd>{titles()}</dd>
        </Show>
      </dl>
      <For each={props.agent.reasons ?? []}>
        {(reason) => <Markdown text={stringOf(jsonRecord(reason)?.text)} untrusted />}
      </For>
      <For each={props.agent.skills ?? []}>
        {(skill) => (
          <details>
            <summary>{stringOf(jsonRecord(skill)?.name)}</summary>
            <Markdown text={stringOf(jsonRecord(skill)?.instructions)} untrusted />
          </details>
        )}
      </For>
    </div>
  )
}
function PlanTiming(props: { value?: Schema.Json; label: string }) {
  const language = useLanguage()
  const label = () => {
    const value = jsonRecord(props.value)
    if (value?.kind === "relative") return stringOf(value.text)
    const at = stringOf(value?.at)
    return at && Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleString(language.intl()) : at
  }
  return (
    <Show when={label()}>
      <p class="reference-kind">
        {props.label}: {label()}
      </p>
    </Show>
  )
}
function PlanGrading(props: { value?: Schema.Json }) {
  const language = useLanguage()
  const grade = () => jsonRecord(props.value)
  const points = () => {
    const value = grade()?.points
    return typeof value === "number" ? value : undefined
  }
  const criteria = () => {
    const value = grade()?.criteria
    return Array.isArray(value) ? value : []
  }
  return (
    <Show when={grade()}>
      <section class="reference-plan-grading">
        <h4>{language.t("groupChat.preview.grading")}</h4>
        <Show when={grade()?.mode === "not_graded"}>
          <p>{language.t("groupChat.preview.notGraded")}</p>
        </Show>
        <Show when={points() !== undefined}>
          <p>{language.t("groupChat.preview.points", { points: points()!.toLocaleString(language.intl()) })}</p>
        </Show>
        <For each={criteria()}>
          {(criterion) => (
            <div>
              <strong>{stringOf(jsonRecord(criterion)?.name)}</strong>
              <p>{stringOf(jsonRecord(criterion)?.description)}</p>
            </div>
          )}
        </For>
      </section>
    </Show>
  )
}
function PlanTask(props: { task: Schema.Json }) {
  const language = useLanguage()
  const data = () => jsonRecord(props.task)
  return (
    <div class="reference-task">
      <strong>{stringOf(data()?.name ?? data()?.title) || language.t("session.sources.task")}</strong>
      <Show when={typeof data()?.reflectionPrompt === "string"}>
        <Markdown text={stringOf(data()?.reflectionPrompt)} untrusted />
      </Show>
      <PlanGrading value={data()?.grading} />
    </div>
  )
}
function stringOf(value: Schema.Json | undefined) {
  return typeof value === "string" ? value : ""
}

function MindMapReferenceContent(props: ReaderProps) {
  const language = useLanguage()
  const [map] = createResource(() => readShown(props, "map"))
  return (
    <Show
      when={map()}
      fallback={
        <p class="reference-notice">
          {language.t(map.error ? "groupChat.preview.failed" : "groupChat.preview.loading")}
        </p>
      }
    >
      {(data) => <ReferenceMindMapViewer data={data()} onOpen={props.onOpen} />}
    </Show>
  )
}

function AttachmentReferenceContent(props: ReaderProps & { attachment: Schema.Json | undefined }) {
  const language = useLanguage()
  const [address] = createResource(async () => {
    const urls = Schema.decodeUnknownSync(Schema.Struct({ urls: Schema.Record(Schema.String, Schema.String) }))(
      await readShown(props, "content"),
    )
    // The server leaves out an attachment whose bytes were cleared or are not available, rather than
    // signing an address to a 404, so a read that names none is final, not still loading.
    return props.item.reference.kind === "attachment" ? urls.urls[String(props.item.reference.attachmentId)] : undefined
  })
  const attachment = () => jsonRecord(props.attachment)
  const mimeType = () => {
    const value = attachment()?.mimeType
    return typeof value === "string" ? value : null
  }
  return (
    <Show
      when={address()}
      fallback={
        <p class="reference-notice">
          {language.t(
            address.error
              ? "groupChat.preview.failed"
              : address.loading
                ? "groupChat.preview.loading"
                : "groupChat.preview.unavailable",
          )}
        </p>
      }
    >
      {(url) => (
        <div class="reference-material-file">
          <ReferenceDownload url={url()} filename={props.item.title} mimeType={mimeType()} mount={props.actions} />
          <ReferenceFileViewer url={url()} title={props.item.title} mimeType={mimeType()} />
        </div>
      )}
    </Show>
  )
}

/** The same opaque-origin, one-load frame boundary used by web chat's Studio and page viewers. */
function ReferencePageFrame(props: { title: string; first?: string; studio?: boolean; renew: () => Promise<string> }) {
  const language = useLanguage()
  const openLink = useExternalLinkConfirm()
  const dialog = useDialog()
  const theme = useTheme()
  const [state, setState] = createStore({ left: false, loads: 0, declined: 0, quietUntil: 0, pending: false })
  let initial = true
  const [address, { refetch }] = createResource(async () => {
    setState({ left: false, loads: 0, declined: 0, quietUntil: 0 })
    const first = initial ? props.first : undefined
    initial = false
    const url = safeReferenceUrl(first ?? (await props.renew()))
    if (!url) throw new Error("Invalid reference page URL")
    return url
  })
  let frame: HTMLIFrameElement | undefined
  const message = (event: MessageEvent) => {
    if (
      !frame ||
      event.source !== frame.contentWindow ||
      state.left ||
      state.pending ||
      state.declined >= 3 ||
      Date.now() < state.quietUntil
    )
      return
    const raw: unknown = event.data
    const decoded = Schema.decodeUnknownOption(Schema.Struct({ type: Schema.String, url: Schema.String }))(raw)
    const data = decoded._tag === "Some" ? decoded.value : undefined
    if (
      !data ||
      data.type !== (props.studio ? "jolli-artifact-link" : "jolli-page-link") ||
      typeof data.url !== "string"
    )
      return
    const url = safeReferenceUrl(data.url)
    if (!url) return
    if (new URL(url).origin === new URL(frame.src).origin) return
    setState("pending", true)
    // Settles when the person answers, so a page that keeps asking is quietened by what they decided.
    void openLink(url).then((followed) =>
      setState({
        pending: false,
        declined: state.declined + (followed ? 0 : 1),
        quietUntil: followed ? 0 : Date.now() + 2000,
      }),
    )
  }
  window.addEventListener("message", message)
  onCleanup(() => window.removeEventListener("message", message))
  onCleanup(() => {
    if (state.pending) dialog.close()
  })
  createEffect(() => {
    const mode = theme.mode()
    if (props.studio && state.loads === 1)
      frame?.contentWindow?.postMessage({ type: "jolli-artifact-theme", theme: mode }, "*")
  })
  return (
    <Show when={!address.loading} fallback={<p class="reference-notice">{language.t("groupChat.preview.loading")}</p>}>
      <Show when={address() && !state.left} fallback={<ReferenceFailure retry={() => void refetch()} />}>
        <Show when={props.studio}>
          <div class="reference-file-actions">
            <button
              type="button"
              class="reference-action"
              disabled={state.loads !== 1 || state.left}
              onClick={() => frame?.contentWindow?.postMessage({ type: "jolli-artifact-print" }, "*")}
            >
              {language.t("groupChat.preview.print")}
            </button>
          </div>
        </Show>
        <iframe
          ref={frame}
          src={address()}
          title={props.title}
          sandbox="allow-scripts allow-modals"
          referrerPolicy="no-referrer"
          class="reference-page-frame"
          data-testid="reference-page-frame"
          onLoad={() => {
            setState("loads", state.loads + 1)
            if (state.loads > 1) {
              setState("left", true)
              return
            }
            if (props.studio)
              frame?.contentWindow?.postMessage(
                {
                  type: "jolli-artifact-theme",
                  theme: theme.mode(),
                },
                "*",
              )
          }}
        />
      </Show>
    </Show>
  )
}

export function ReferenceFailure(props: { retry: () => void }) {
  const language = useLanguage()
  return (
    <div class="reference-notice" role="alert">
      <p>{language.t("groupChat.preview.failed")}</p>
      <button type="button" class="reference-action" onClick={props.retry}>
        {language.t("groupChat.preview.retry")}
      </button>
    </div>
  )
}
