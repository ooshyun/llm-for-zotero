import { appLogger } from "../../core/logging";
import { isClaudeCodeModeEnabled } from "../../claudeCode/prefs";
import { resolvePaperContextRefFromAttachment } from "../../services/paperContent/paperAttribution";
import { parseAsk, renderComment, type AskState } from "./commentProtocol";
import { isAnnotationAskEnabled } from "./prefs";
import {
  runAnnotationAskTurn,
  type AnnotationAskTurnRunner,
} from "./turnRunner";

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

async function writeAskState(
  annotationId: number,
  original: string,
  state: AskState,
): Promise<void> {
  const annotation = Zotero.Items.get(
    annotationId,
  ) as unknown as MinimalAnnotation | null;
  if (!annotation) return;
  annotation.annotationComment = renderComment(original, state);
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
    await writeAskState(annotationId, original, {
      kind: "failed",
      reason: "paper context unavailable",
    });
    return;
  }

  await writeAskState(annotationId, original, { kind: "pending" });

  try {
    const text = await runner({
      title: paperContext.title,
      pageLabel: annotation.annotationPageLabel || undefined,
      highlight: annotation.annotationText || "",
      question,
      paperContext,
      annotationItemId: annotationId,
    });
    await writeAskState(annotationId, original, { kind: "answered", text });
  } catch (err) {
    const reason = truncateFailureReason(
      err instanceof Error ? err.message : String(err),
    );
    await writeAskState(annotationId, original, { kind: "failed", reason });
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

  const annotation = Zotero.Items.get(
    annotationId,
  ) as unknown as MinimalAnnotation | null;
  if (!annotation?.isAnnotation?.()) return;
  if (!isEligibleAnnotation(annotation)) return;

  const pdfAttachment = annotation.parentID
    ? (Zotero.Items.get(
        annotation.parentID,
      ) as unknown as MinimalAttachment | null)
    : null;
  if (
    !pdfAttachment?.isAttachment?.() ||
    pdfAttachment.attachmentContentType !== "application/pdf"
  ) {
    return;
  }

  const parsed = parseAsk(String(annotation.annotationComment || ""));
  if (!parsed) return;

  inFlight.add(annotationId);
  await scheduleAsk(() =>
    processAsk(
      annotationId,
      pdfAttachment.id,
      parsed.question,
      parsed.original,
      runner,
    ).finally(() => {
      inFlight.delete(annotationId);
    }),
  );
}

async function handleItemNotification(
  event: string,
  type: string,
  ids: Array<string | number>,
  runner: AnnotationAskTurnRunner,
): Promise<void> {
  if (type !== "item") return;
  if (event !== "add" && event !== "modify") return;
  // Read the gate fresh on every notification so toggling the preference
  // takes effect without restarting Zotero.
  if (!isFeatureActive()) return;

  for (const rawId of ids) {
    const id = normalizeItemId(rawId);
    if (id === null) continue;
    try {
      await considerAnnotation(id, runner);
    } catch (err) {
      appLogger.warn("Annotation ask: failed to process annotation", err);
    }
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
            void handleItemNotification(
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
    } catch {
      /* ignore */
    }
    notifierId = null;
  }
  inFlight.clear();
  queue = Promise.resolve();
}

export function setAnnotationAskTurnRunnerForTests(
  runner: AnnotationAskTurnRunner,
): void {
  activeRunner = runner;
}

export async function handleAnnotationAskNotificationForTests(
  event: string,
  type: string,
  ids: Array<string | number>,
): Promise<void> {
  await handleItemNotification(event, type, ids, activeRunner);
}

export function resetAnnotationAskWatchForTests(): void {
  notifierId = null;
  activeRunner = runAnnotationAskTurn;
  inFlight.clear();
  queue = Promise.resolve();
}
