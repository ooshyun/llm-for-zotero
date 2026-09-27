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

// MUST KILL: CONVERSATION_KEY_BASE should derive from RUNTIME_CONVERSATION_KEY_END, not restate it.
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

export const runAnnotationAskTurn: AnnotationAskTurnRunner = async (input) => {
  const request = await buildAnnotationAskRequest(input);
  const outcome = await getAgentApi().runTurn(request);

  if (outcome.kind === "completed") return outcome.text;
  throw new Error(outcome.reason || "Claude turn did not complete");
};
