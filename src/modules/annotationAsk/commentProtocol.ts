/**
 * Pure parsing/rendering for the `@claude` annotation-comment protocol.
 * No Zotero dependency — the comment string is the entire persistent state.
 */

export const TRIGGER = /@claude\b/i;

const ANSWER_MARKER = "\n\nClaude:";

const DEFAULT_QUESTION = "이 부분을 설명해줘.";

export type AskState =
  | { kind: "pending" }
  | { kind: "answered"; text: string }
  | { kind: "failed"; reason: string };

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

export function renderComment(original: string, state: AskState): string {
  switch (state.kind) {
    case "pending":
      return `${original}\n\nClaude: 답변 작성 중...`;
    case "answered":
      return `${original}\n\nClaude:\n${state.text}`;
    case "failed":
      return `${original}\n\nClaude: 실패 (${state.reason}). 이 블록을 지우면 다시 시도합니다.`;
  }
}

export function buildPrompt(params: {
  title: string;
  pageLabel?: string;
  highlight: string;
  question: string;
}): string {
  const location = params.pageLabel ? ` (page ${params.pageLabel})` : "";
  return [
    `You are answering a question about a highlighted passage from the paper "${params.title}"${location}.`,
    `Highlighted passage:`,
    `"""`,
    params.highlight,
    `"""`,
    `Question: ${params.question}`,
    ``,
    `Answer in Korean. Write plain text only: this answer is written back into a Zotero annotation comment, which does not render Markdown, so do not use Markdown syntax (no #, *, -, backticks, etc). Keep the whole answer under about 1500 characters. Put any URL alone on its own line, and only include a URL you actually retrieved with a web tool during this turn; never invent one. Output only the answer text itself, with no preamble, labels, or restatement of the question.`,
  ].join("\n");
}
