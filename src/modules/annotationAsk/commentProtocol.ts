/**
 * Pure parsing/rendering for the `@claude` annotation-comment protocol.
 * No Zotero dependency — the comment string is the entire persistent state.
 */

export const TRIGGER = /@claude\b/i;

const ANSWER_MARKER = "\n\nClaude:";

const PENDING_BLOCK = "\n\nClaude: 답변 작성 중...";

const DEFAULT_QUESTION = "이 부분을 설명해줘.";

export type AskState =
  | { kind: "pending" }
  | { kind: "answered"; text: string }
  | { kind: "failed"; reason: string };

export type FinalAskState = Extract<
  AskState,
  { kind: "answered" } | { kind: "failed" }
>;

export type ParsedAsk = {
  question: string;
  original: string;
};

/**
 * Detects a fresh `@claude` request. Returns null when the trigger is absent,
 * or when the answer marker is already present — the marker makes every
 * downstream state (pending/answered/failed) a no-op re-trigger, so the user
 * must delete the Claude block to ask again.
 */
export function parseAsk(comment: string): ParsedAsk | null {
  if (!TRIGGER.test(comment)) return null;
  if (comment.includes(ANSWER_MARKER)) return null;

  const original = comment.replace(/\s+$/, "");
  const question = original.replace(TRIGGER, "").trim();

  return {
    question: question || DEFAULT_QUESTION,
    original,
  };
}

/** Just the appended Claude block for a state, without the original comment. */
export function renderAskBlock(state: AskState): string {
  switch (state.kind) {
    case "pending":
      return PENDING_BLOCK;
    case "answered":
      return `\n\nClaude:\n${state.text}`;
    case "failed":
      return `\n\nClaude: 실패 (${state.reason}). 이 블록을 지우면 다시 시도합니다.`;
  }
}

export function renderComment(original: string, state: AskState): string {
  return `${original}${renderAskBlock(state)}`;
}

function replaceFirst(
  haystack: string,
  needle: string,
  replacement: string,
): string {
  const index = haystack.indexOf(needle);
  if (index === -1) return haystack;
  return (
    haystack.slice(0, index) +
    replacement +
    haystack.slice(index + needle.length)
  );
}

/**
 * The turn can take many seconds, and Zotero's reader autosaves the comment
 * field as the user types, so the comment holding the pending write can
 * change before the final one lands. Re-reading and reconciling instead of
 * blindly overwriting keeps whatever the user did in the meantime:
 *   - unchanged since the pending write -> render normally from `original`.
 *   - still carries the pending block, just with other edits around it ->
 *     replace only that block, leaving the edits.
 *   - the pending block is gone (the user deleted it, or the whole comment
 *     changed) -> append the final block to whatever is there now.
 */
export function reconcileFinalComment(params: {
  original: string;
  currentComment: string;
  finalState: FinalAskState;
}): string {
  const { original, currentComment, finalState } = params;
  if (currentComment === renderComment(original, { kind: "pending" })) {
    return renderComment(original, finalState);
  }
  if (currentComment.includes(PENDING_BLOCK)) {
    return replaceFirst(
      currentComment,
      PENDING_BLOCK,
      renderAskBlock(finalState),
    );
  }
  return `${currentComment}${renderAskBlock(finalState)}`;
}

export function buildPrompt(params: {
  title: string;
  pageLabel?: string;
  highlight: string;
  question: string;
}): string {
  const location = params.pageLabel ? ` (page ${params.pageLabel})` : "";
  const readAround = params.pageLabel
    ? ` Before answering, read the PDF pages around page ${params.pageLabel} (where the highlight sits) for surrounding context — do not rely on the quoted snippet alone.`
    : "";
  return [
    `You are answering a question about a highlighted passage from the paper "${params.title}"${location}.`,
    `Highlighted passage:`,
    `"""`,
    params.highlight,
    `"""`,
    `Question: ${params.question}`,
    ``,
    `Answer in Korean. Write plain text only: this answer is written back into a Zotero annotation comment, which does not render Markdown, so do not use Markdown syntax (no #, *, -, backticks, etc). Keep the whole answer under about 1500 characters. Put any URL alone on its own line, and only include a URL you actually retrieved with a web tool during this turn; never invent one.${readAround} Output only the answer text itself, with no preamble, labels, or restatement of the question.`,
  ].join("\n");
}
