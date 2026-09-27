import { getAgentApi } from "../../agent";
import { buildClaudeReasoningConfig } from "../../claudeCode/runtime";
import { getClaudeRuntimeModelPref } from "../../claudeCode/prefs";
import type { PaperContextRef } from "../../shared/types";
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
  const libraryID = input.paperContext.libraryID;
  if (!libraryID) {
    throw new Error("Paper has no active Zotero library");
  }

  const outcome = await getAgentApi().runTurn({
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
    activePaperContext: input.paperContext,
    selectedTexts: [input.highlight],
    model: getClaudeRuntimeModelPref(),
    reasoning: buildClaudeReasoningConfig(),
  });

  if (outcome.kind === "completed") return outcome.text;
  throw new Error(outcome.reason || "Claude turn did not complete");
};
