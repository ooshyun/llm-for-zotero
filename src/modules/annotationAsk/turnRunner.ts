import { getAgentApi } from "../../agent";
import type { AgentRuntimeRequestInput } from "../../agent/types";
import { buildClaudeReasoningConfig } from "../../claudeCode/runtime";
import { getClaudeRuntimeModelPref } from "../../claudeCode/prefs";
import type { PaperContextRef } from "../../shared/types";
import { sessionFor } from "./paperSessions";
import { buildPrompt } from "./commentProtocol";

export type AnnotationAskTurnInput = {
  title: string;
  pageLabel?: string;
  highlight: string;
  question: string;
  paperContext: PaperContextRef;
};

export type AnnotationAskTurnRunner = (
  input: AnnotationAskTurnInput,
) => Promise<string>;

export type AnnotationAskPdfPathResolver = (
  attachmentId: number,
) => Promise<string | null>;

async function resolveAttachmentPdfPath(
  attachmentId: number,
): Promise<string | null> {
  const attachment = Zotero.Items.get(attachmentId) as
    | (Zotero.Item & { getFilePathAsync?: () => Promise<string | false> })
    | null;
  if (!attachment) return null;
  try {
    const path = await attachment.getFilePathAsync?.();
    return typeof path === "string" && path ? path : null;
  } catch {
    return null;
  }
}

export async function buildAnnotationAskRequest(
  input: AnnotationAskTurnInput,
  deps: { resolvePdfPath?: AnnotationAskPdfPathResolver } = {},
): Promise<AgentRuntimeRequestInput> {
  const libraryID = input.paperContext.libraryID;
  if (!libraryID) {
    throw new Error("Paper has no active Zotero library");
  }

  const resolvePdfPath = deps.resolvePdfPath || resolveAttachmentPdfPath;
  const pdfPath = await resolvePdfPath(input.paperContext.contextItemId);

  return {
    conversationKey: sessionFor(input.paperContext.contextItemId)
      .conversationKey,
    mode: "agent",
    conversationKind: "paper",
    userText: buildPrompt({
      title: input.title,
      pageLabel: input.pageLabel,
      highlight: input.highlight,
      question: input.question,
      pdfPath,
    }),
    activeItemId: input.paperContext.itemId,
    libraryID,
    activePaperContext: input.paperContext,
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
