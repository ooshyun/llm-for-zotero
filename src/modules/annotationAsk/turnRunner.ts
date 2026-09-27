import { appLogger } from "../../core/logging";
import { getAgentApi } from "../../agent";
import type { AgentRuntimeRequestInput } from "../../agent/types";
import { buildClaudeReasoningConfig } from "../../claudeCode/runtime";
import { getClaudeRuntimeModelPref } from "../../claudeCode/prefs";
import type {
  LocalDocumentResource,
  PaperContextRef,
} from "../../shared/types";
import { createLocalPdfResourceResolver } from "../contextPanel/setupHandlers/controllers/localPdfResourceResolver";
import { buildPrompt } from "./commentProtocol";

/**
 * Above every conversation-key range any conversation system currently
 * allocates (`RUNTIME_CONVERSATION_KEY_END` in
 * `../../shared/conversationKeySpace`), so a one-shot annotation turn can
 * never collide with, resume, or appear alongside a real sidebar chat.
 */
const CONVERSATION_KEY_BASE = 9_000_000_000_000_000;

export function buildAnnotationAskConversationKey(
  annotationItemId: number,
): number {
  const normalized = Math.max(0, Math.floor(annotationItemId) || 0);
  return CONVERSATION_KEY_BASE + normalized;
}

export type AnnotationAskTurnInput = {
  title: string;
  pageLabel?: string;
  highlight: string;
  question: string;
  paperContext: PaperContextRef;
  annotationItemId: number;
};

export type AnnotationAskTurnRunner = (
  input: AnnotationAskTurnInput,
) => Promise<string>;

export type AnnotationAskLocalPdfResolver = {
  resolve: (
    paperContexts: PaperContextRef[],
  ) => Promise<readonly LocalDocumentResource[]>;
};

/**
 * Builds the turn request for one annotation question, reusing the sidebar
 * chat's own raw-PDF resolver (`createLocalPdfResourceResolver`, also used by
 * `src/modules/contextPanel/chat.ts:6724,8417`) instead of a second one. That
 * resolver turns a `contentSourceMode: "pdf"` paper context into the
 * `LocalDocumentResource` (`absolutePath` from `getFilePathAsync()`) the
 * bridge's "Raw PDF transport policy" block and "Selected papers" list need —
 * without it, only `activePaperContext`'s title/citation metadata reaches the
 * bridge prompt, not the file the model can actually read.
 *
 * When the resolver fails (file missing, not a real PDF, etc.) this falls
 * back to the metadata-only paper context rather than failing the whole
 * annotation turn.
 */
export async function buildAnnotationAskRequest(
  input: AnnotationAskTurnInput,
  deps: { localPdfResolver?: AnnotationAskLocalPdfResolver } = {},
): Promise<AgentRuntimeRequestInput> {
  const libraryID = input.paperContext.libraryID;
  if (!libraryID) {
    throw new Error("Paper has no active Zotero library");
  }

  const pdfPaperContext: PaperContextRef = {
    ...input.paperContext,
    contentSourceMode: "pdf",
  };

  const resolver = deps.localPdfResolver || createLocalPdfResourceResolver();
  let localDocuments: readonly LocalDocumentResource[] = [];
  try {
    localDocuments = await resolver.resolve([pdfPaperContext]);
  } catch (err) {
    appLogger.warn(
      "Annotation ask: could not resolve the raw PDF path; falling back to metadata-only paper context",
      err,
    );
  }

  const hasLocalPdf = localDocuments.length > 0;

  return {
    conversationKey: buildAnnotationAskConversationKey(input.annotationItemId),
    mode: "agent",
    conversationKind: "paper",
    userText: buildPrompt({
      title: input.title,
      pageLabel: input.pageLabel,
      highlight: input.highlight,
      question: input.question,
    }),
    activeItemId: input.paperContext.itemId,
    libraryID,
    activePaperContext: hasLocalPdf ? pdfPaperContext : input.paperContext,
    pdfPaperContexts: hasLocalPdf ? [pdfPaperContext] : undefined,
    localDocuments: hasLocalPdf ? localDocuments : undefined,
    selectedTexts: [input.highlight],
    model: getClaudeRuntimeModelPref(),
    reasoning: buildClaudeReasoningConfig(),
  };
}

/**
 * Runs one Claude turn for an annotation `@claude` question through the
 * shared agent runtime — `getAgentApi().runTurn`, the same entry point the
 * public extension API uses (`src/agent/index.ts`). This never touches the
 * chat-conversation store: `runTurn` itself only persists an internal run
 * trace keyed by `conversationKey` (for resuming/inspecting a run), not the
 * sidebar conversation list — that list is populated by separate,
 * explicitly-called functions (`createClaudeConversationForScope`,
 * `appendClaudeConversationMessage`, ...) that this path never calls. The
 * dedicated, out-of-range conversation key above keeps even that internal
 * trace isolated per annotation.
 */
export const runAnnotationAskTurn: AnnotationAskTurnRunner = async (input) => {
  const request = await buildAnnotationAskRequest(input);
  const outcome = await getAgentApi().runTurn(request);

  if (outcome.kind === "completed") return outcome.text;
  throw new Error(outcome.reason || "Claude turn did not complete");
};
