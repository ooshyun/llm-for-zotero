import { appLogger } from "../../core/logging";
import { isClaudeCodeModeEnabled } from "../../claudeCode/prefs";
import { resolvePaperContextRefFromAttachment } from "../../services/paperContent/paperAttribution";
import {
  parseAsk,
  reconcileFinalComment,
  renderComment,
  type FinalAskState,
} from "./commentProtocol";
import { isAnnotationAskEnabled } from "./prefs";
import {
  runAnnotationAskTurn,
  type AnnotationAskTurnRunner,
} from "./turnRunner";

// Zotero's PDF reader autosaves the annotation comment on every keystroke, so
// a "modify" notification can carry a half-typed "@claude ...".
const DEBOUNCE_MS = 3000;
let debounceMsOverride: number | null = null;

function getDebounceMs(): number {
  return debounceMsOverride ?? DEBOUNCE_MS;
}

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
let activeRunner: AnnotationAskTurnRunner = runAnnotationAskTurn;
const inFlight = new Set<number>();
const debounceTimers = new Map<number, ReturnType<typeof setTimeout>>();
let queue: Promise<void> = Promise.resolve();

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
      annotationItemId: annotationId,
    });
    await writeFinalState(annotationId, original, { kind: "answered", text });
  } catch (err) {
    const reason = truncateFailureReason(
      err instanceof Error ? err.message : String(err),
    );
    await writeFinalState(annotationId, original, { kind: "failed", reason });
  }
}

function scheduleAsk(task: () => Promise<void>): Promise<void> {
  const started = queue.then(task);
  queue = started.catch(() => undefined);
  return started;
}

async function considerAnnotation(
  annotationId: number,
  runner: AnnotationAskTurnRunner,
): Promise<void> {
  if (inFlight.has(annotationId)) return;

  const candidate = getCandidateAnnotation(annotationId);
  if (!candidate) return;

  const parsed = parseAsk(String(candidate.annotation.annotationComment || ""));
  if (!parsed) return;

  inFlight.add(annotationId);
  await scheduleAsk(() =>
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

function scheduleAnnotationCheck(
  annotationId: number,
  runner: AnnotationAskTurnRunner,
): void {
  const existing = debounceTimers.get(annotationId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    debounceTimers.delete(annotationId);
    void considerAnnotation(annotationId, runner).catch((err) => {
      appLogger.warn("Annotation ask: failed to process annotation", err);
    });
  }, getDebounceMs());
  debounceTimers.set(annotationId, timer);
}

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
    if (!getCandidateAnnotation(id)) continue;
    scheduleAnnotationCheck(id, runner);
  }
}

export function startAnnotationAskWatch(): void {
  if (notifierId) return;

  try {
    const notifier = (
      Zotero as unknown as {
        Notifier?: {
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
      }
    ).Notifier;

    if (notifier?.registerObserver) {
      notifierId = notifier.registerObserver(
        {
          notify(
            event: string,
            type: string,
            ids: unknown[],
            _extraData: Record<string, unknown>,
          ) {
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
      appLogger.info("Annotation ask: started");
    }
  } catch (err) {
    appLogger.warn("Annotation ask: failed to start", err);
  }
}

export function stopAnnotationAskWatch(): void {
  if (notifierId) {
    try {
      const notifier = (
        Zotero as unknown as {
          Notifier?: { unregisterObserver?: (id: string) => void };
        }
      ).Notifier;
      notifier?.unregisterObserver?.(notifierId);
    } catch {}
    notifierId = null;
  }
  for (const timer of debounceTimers.values()) clearTimeout(timer);
  debounceTimers.clear();
  inFlight.clear();
  queue = Promise.resolve();
}

export function setAnnotationAskTurnRunnerForTests(
  runner: AnnotationAskTurnRunner,
): void {
  activeRunner = runner;
}

export function setAnnotationAskDebounceMsForTests(ms: number | null): void {
  debounceMsOverride = ms;
}

export function handleAnnotationAskNotificationForTests(
  event: string,
  type: string,
  ids: Array<string | number>,
): void {
  handleItemNotification(event, type, ids, activeRunner);
}

export function resetAnnotationAskWatchForTests(): void {
  notifierId = null;
  activeRunner = runAnnotationAskTurn;
  debounceMsOverride = null;
  for (const timer of debounceTimers.values()) clearTimeout(timer);
  debounceTimers.clear();
  inFlight.clear();
  queue = Promise.resolve();
}
