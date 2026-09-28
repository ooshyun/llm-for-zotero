import { appLogger } from "../../core/logging";
import { isClaudeCodeModeEnabled } from "../../claudeCode/prefs";
import { resolvePaperContextRefFromAttachment } from "../../services/paperContent/paperAttribution";
import {
  parseAsk,
  reconcileFinalComment,
  renderComment,
  type FinalAskState,
} from "./commentProtocol";
import { closePaperSession, openPaperSession } from "./paperSessions";
import { isAnnotationAskEnabled } from "./prefs";
import {
  runAnnotationAskTurn,
  type AnnotationAskTurnRunner,
} from "./turnRunner";

// The reader saves a comment edit up to 1000 ms after the last keystroke, so
// the saved comment can trail the one the user just submitted.
const SUBMIT_RECHECK_MS = 1200;
const SUBMIT_TTL_MS = 15_000;
let submitTimingOverride: { recheckMs: number; ttlMs: number } | null = null;

type Submission = {
  armedAt: number;
  /** The comment the reader will save, or null when the reader cannot tell. */
  comment: string | null;
};

type AskSource = "added" | "submitted";

type MinimalAnnotation = {
  id: number;
  isAnnotation?: () => boolean;
  annotationType?: string;
  annotationText?: string;
  annotationComment?: string;
  annotationPageLabel?: string;
  parentID?: number;
  saveTx: () => Promise<void>;
};

type MinimalAttachment = {
  id: number;
  isAttachment?: () => boolean;
  attachmentContentType?: string;
};

function isFeatureActive(): boolean {
  return isAnnotationAskEnabled() && isClaudeCodeModeEnabled();
}

let notifierId: string | null = null;
let tabNotifierId: string | null = null;
let activeRunner: AnnotationAskTurnRunner = runAnnotationAskTurn;
const inFlight = new Set<number>();
const submitted = new Map<number, Submission>();
const recheckTimers = new Map<number, ReturnType<typeof setTimeout>>();
// Keyed by PDF attachment id, which is 1:1 with a paper session: turns on one
// paper resume the same Claude session and must not overlap, while different
// papers answer concurrently.
const paperQueues = new Map<number, Promise<void>>();

// Zotero's "close" tab notification carries no per-tab data (see
// handleTabNotification), so the attachment a closing tab belonged to must
// be resolved from what its "add" notification recorded.
const tabAttachmentIds = new Map<string, number>();

function normalizeItemId(id: string | number): number | null {
  const parsed = typeof id === "string" ? parseInt(id, 10) : id;
  return Number.isFinite(parsed) ? parsed : null;
}

function truncateFailureReason(reason: string): string {
  const trimmed = (reason || "").trim() || "알 수 없는 오류";
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}

function isEligibleAnnotation(annotation: MinimalAnnotation): boolean {
  if (String(annotation.annotationText || "").trim()) return true;
  return annotation.annotationType === "note";
}

function getPdfAttachmentParent(
  annotation: MinimalAnnotation,
): MinimalAttachment | null {
  const pdfAttachment = annotation.parentID
    ? (Zotero.Items.get(
        annotation.parentID,
      ) as unknown as MinimalAttachment | null)
    : null;
  if (
    !pdfAttachment?.isAttachment?.() ||
    pdfAttachment.attachmentContentType !== "application/pdf"
  ) {
    return null;
  }
  return pdfAttachment;
}

/** Structural eligibility only — independent of what is currently typed. */
function getCandidateAnnotation(annotationId: number): {
  annotation: MinimalAnnotation;
  pdfAttachment: MinimalAttachment;
} | null {
  const annotation = Zotero.Items.get(
    annotationId,
  ) as unknown as MinimalAnnotation | null;
  if (!annotation?.isAnnotation?.() || !isEligibleAnnotation(annotation)) {
    return null;
  }
  const pdfAttachment = getPdfAttachmentParent(annotation);
  if (!pdfAttachment) return null;
  return { annotation, pdfAttachment };
}

async function writePendingState(
  annotationId: number,
  original: string,
): Promise<void> {
  const annotation = Zotero.Items.get(
    annotationId,
  ) as unknown as MinimalAnnotation | null;
  if (!annotation) return;
  annotation.annotationComment = renderComment(original, { kind: "pending" });
  await annotation.saveTx();
}

async function writeFinalState(
  annotationId: number,
  original: string,
  finalState: FinalAskState,
): Promise<void> {
  const annotation = Zotero.Items.get(
    annotationId,
  ) as unknown as MinimalAnnotation | null;
  if (!annotation) return;
  const currentComment = String(annotation.annotationComment || "");
  annotation.annotationComment = reconcileFinalComment({
    original,
    currentComment,
    finalState,
  });
  await annotation.saveTx();
}

async function processAsk(
  annotationId: number,
  pdfAttachmentId: number,
  question: string,
  original: string,
  runner: AnnotationAskTurnRunner,
): Promise<void> {
  const annotation = Zotero.Items.get(
    annotationId,
  ) as unknown as MinimalAnnotation | null;
  const pdfAttachment = Zotero.Items.get(pdfAttachmentId);
  const paperContext = pdfAttachment
    ? resolvePaperContextRefFromAttachment(pdfAttachment)
    : null;

  if (!annotation || !paperContext) {
    await writeFinalState(annotationId, original, {
      kind: "failed",
      reason: "paper context unavailable",
    });
    return;
  }

  await writePendingState(annotationId, original);

  try {
    const text = await runner({
      title: paperContext.title,
      pageLabel: annotation.annotationPageLabel || undefined,
      highlight: annotation.annotationText || "",
      question,
      paperContext,
    });
    await writeFinalState(annotationId, original, { kind: "answered", text });
  } catch (err) {
    const reason = truncateFailureReason(
      err instanceof Error ? err.message : String(err),
    );
    await writeFinalState(annotationId, original, { kind: "failed", reason });
  }
}

function scheduleAsk(
  pdfAttachmentId: number,
  task: () => Promise<void>,
): Promise<void> {
  const previous = paperQueues.get(pdfAttachmentId) ?? Promise.resolve();
  const started = previous.then(task);
  const tail: Promise<void> = started
    .catch(() => undefined)
    .then(() => {
      if (paperQueues.get(pdfAttachmentId) === tail) {
        paperQueues.delete(pdfAttachmentId);
      }
    });
  paperQueues.set(pdfAttachmentId, tail);
  return started;
}

function disarm(annotationId: number): void {
  submitted.delete(annotationId);
  clearTimeout(recheckTimers.get(annotationId));
  recheckTimers.delete(annotationId);
}

function liveSubmission(annotationId: number): Submission | null {
  const submission = submitted.get(annotationId);
  if (!submission) return null;
  const ttlMs = submitTimingOverride?.ttlMs ?? SUBMIT_TTL_MS;
  if (Date.now() - submission.armedAt <= ttlMs) return submission;
  disarm(annotationId);
  return null;
}

async function considerAnnotation(
  annotationId: number,
  source: AskSource,
  runner: AnnotationAskTurnRunner,
): Promise<void> {
  if (inFlight.has(annotationId)) return;

  const submission =
    source === "submitted" ? liveSubmission(annotationId) : null;
  if (source === "submitted" && !submission) return;

  const candidate = getCandidateAnnotation(annotationId);
  if (!candidate) return;

  const comment = String(candidate.annotation.annotationComment || "");
  if (submission?.comment != null && comment !== submission.comment) return;
  const parsed = parseAsk(comment);
  if (!parsed) return;

  disarm(annotationId);
  inFlight.add(annotationId);
  await scheduleAsk(candidate.pdfAttachment.id, () =>
    processAsk(
      annotationId,
      candidate.pdfAttachment.id,
      parsed.question,
      parsed.original,
      runner,
    ).finally(() => {
      inFlight.delete(annotationId);
    }),
  );
}

function checkAnnotation(
  annotationId: number,
  source: AskSource,
  runner: AnnotationAskTurnRunner,
): void {
  void considerAnnotation(annotationId, source, runner).catch((err) => {
    appLogger.warn("Annotation ask: failed to process annotation", err);
  });
}

/**
 * The user pressed Enter in this annotation's comment editor. The ask runs
 * once the saved comment matches what they submitted: right away if it is
 * already saved, else on the reader's next save.
 */
export function armAnnotationAsk(
  annotationId: number,
  comment: string | null = null,
): void {
  if (!isFeatureActive()) return;
  disarm(annotationId);
  submitted.set(annotationId, { armedAt: Date.now(), comment });
  checkAnnotation(annotationId, "submitted", activeRunner);
  recheckTimers.set(
    annotationId,
    setTimeout(() => {
      recheckTimers.delete(annotationId);
      checkAnnotation(annotationId, "submitted", activeRunner);
    }, submitTimingOverride?.recheckMs ?? SUBMIT_RECHECK_MS),
  );
}

/**
 * A UI-created annotation starts with an empty comment, so an "add" that
 * already carries the trigger was written through the API and asks at once.
 * A "modify" asks only for a submitted annotation: the reader autosaves
 * half-typed comments.
 */
function handleItemNotification(
  event: string,
  type: string,
  ids: Array<string | number>,
  runner: AnnotationAskTurnRunner,
): void {
  if (type !== "item") return;
  if (event !== "add" && event !== "modify") return;
  if (!isFeatureActive()) return;

  for (const rawId of ids) {
    const id = normalizeItemId(rawId);
    if (id === null) continue;
    if (event === "add") checkAnnotation(id, "added", runner);
    else if (submitted.has(id)) checkAnnotation(id, "submitted", runner);
  }
}

/**
 * A reader tab's "add" notification carries { itemID, type } keyed by tab id
 * (Zotero_Tabs.add -> Notifier.trigger('add', 'tab', [id], { [id]: { ...data,
 * type } })), so the attachment a tab belongs to is known up front. A "close"
 * notification carries no such data (Notifier.trigger('close', 'tab',
 * [closedIDs], true)), so it can only resolve the attachment through what
 * "add" recorded.
 */
function handleTabNotification(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: Record<string, unknown>,
): void {
  if (type !== "tab") return;

  if (event === "add") {
    for (const rawId of ids) {
      const tabId = String(rawId);
      const data = extraData?.[tabId] as
        | { itemID?: unknown; type?: unknown }
        | undefined;
      if (data?.type !== "reader") continue;
      const rawItemId = data.itemID;
      if (typeof rawItemId !== "string" && typeof rawItemId !== "number") {
        continue;
      }
      const attachmentId = normalizeItemId(rawItemId);
      if (attachmentId === null) continue;
      tabAttachmentIds.set(tabId, attachmentId);
      openPaperSession(attachmentId);
    }
    return;
  }

  if (event !== "close") return;
  for (const rawId of ids) {
    const tabId = String(rawId);
    const attachmentId = tabAttachmentIds.get(tabId);
    tabAttachmentIds.delete(tabId);
    if (attachmentId !== undefined) closePaperSession(attachmentId);
  }
}

type ZoteroNotifier = {
  registerObserver?: (
    observer: {
      notify: (
        event: string,
        type: string,
        ids: unknown[],
        extraData: Record<string, unknown>,
      ) => void;
    },
    types: string[],
    id?: string,
  ) => string;
  unregisterObserver?: (id: string) => void;
};

function getZoteroNotifier(): ZoteroNotifier | undefined {
  return (Zotero as unknown as { Notifier?: ZoteroNotifier }).Notifier;
}

export function startAnnotationAskWatch(): void {
  if (notifierId) return;

  try {
    const notifier = getZoteroNotifier();

    if (notifier?.registerObserver) {
      notifierId = notifier.registerObserver(
        {
          notify(event, type, ids) {
            handleItemNotification(
              event,
              type,
              ids as Array<string | number>,
              activeRunner,
            );
          },
        },
        ["item"],
        "annotationAskWatch",
      );
      tabNotifierId = notifier.registerObserver(
        {
          notify(event, type, ids, extraData) {
            handleTabNotification(
              event,
              type,
              ids as Array<string | number>,
              extraData,
            );
          },
        },
        ["tab"],
        "annotationAskTabWatch",
      );
      appLogger.info("Annotation ask: started");
    }
  } catch (err) {
    appLogger.warn("Annotation ask: failed to start", err);
  }
}

export function stopAnnotationAskWatch(): void {
  if (notifierId || tabNotifierId) {
    try {
      const notifier = getZoteroNotifier();
      if (notifierId) notifier?.unregisterObserver?.(notifierId);
      if (tabNotifierId) notifier?.unregisterObserver?.(tabNotifierId);
    } catch {}
    notifierId = null;
    tabNotifierId = null;
  }
  for (const timer of recheckTimers.values()) clearTimeout(timer);
  recheckTimers.clear();
  submitted.clear();
  inFlight.clear();
  tabAttachmentIds.clear();
  paperQueues.clear();
}

export function setAnnotationAskTurnRunnerForTests(
  runner: AnnotationAskTurnRunner,
): void {
  activeRunner = runner;
}

export function setAnnotationAskSubmitTimingForTests(
  timing: { recheckMs: number; ttlMs: number } | null,
): void {
  submitTimingOverride = timing;
}

export function handleAnnotationAskNotificationForTests(
  event: string,
  type: string,
  ids: Array<string | number>,
): void {
  handleItemNotification(event, type, ids, activeRunner);
}

export function handleAnnotationAskTabNotificationForTests(
  event: string,
  ids: Array<string | number>,
  extraData: Record<string, unknown> = {},
): void {
  handleTabNotification(event, "tab", ids, extraData);
}

export function resetAnnotationAskWatchForTests(): void {
  notifierId = null;
  tabNotifierId = null;
  activeRunner = runAnnotationAskTurn;
  submitTimingOverride = null;
  for (const timer of recheckTimers.values()) clearTimeout(timer);
  recheckTimers.clear();
  submitted.clear();
  inFlight.clear();
  tabAttachmentIds.clear();
  paperQueues.clear();
}
