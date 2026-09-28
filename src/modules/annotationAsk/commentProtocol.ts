import { MENTION_TRIGGER } from "./mentionAgents";

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
  /** The trimmed text of earlier questions and answers, absent for a first ask. */
  priorThread?: string;
};

function globalTrigger(): RegExp {
  return new RegExp(MENTION_TRIGGER.source, `${MENTION_TRIGGER.flags}g`);
}

/** A single line's worth of trigger + question, trimmed to a question. */
function extractQuestion(line: string): string {
  const question = line
    .replace(MENTION_TRIGGER, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  return question || DEFAULT_QUESTION;
}

/** The index of the last `@claude` match starting after `afterIndex`, or -1. */
function lastTriggerIndexAfter(comment: string, afterIndex: number): number {
  let lastIndex = -1;
  for (const match of comment.matchAll(globalTrigger())) {
    if (match.index !== undefined && match.index > afterIndex) {
      lastIndex = match.index;
    }
  }
  return lastIndex;
}

/** The start of the line containing `index` (the character after the nearest preceding newline). */
function lineStartBefore(comment: string, index: number): number {
  const newlineIndex = comment.lastIndexOf("\n", index - 1);
  return newlineIndex === -1 ? 0 : newlineIndex + 1;
}

/**
 * A comment is a thread of one or more `@claude` questions, each followed by
 * a `\n\nClaude:` answer, pending, or failed block. The pending ask, if any,
 * is the last trigger that comes after the last answer marker: with no
 * marker yet, that is the whole comment; with one, a trigger before it is
 * already answered, and no trigger after it means the last block is still
 * pending, answered, or failed with nothing typed since.
 */
export function parseAsk(comment: string): ParsedAsk | null {
  const original = comment.replace(/\s+$/, "");
  const lastMarkerIndex = comment.lastIndexOf(ANSWER_MARKER);

  if (lastMarkerIndex === -1) {
    if (!MENTION_TRIGGER.test(comment)) return null;
    return { question: extractQuestion(original), original };
  }

  const triggerIndex = lastTriggerIndexAfter(comment, lastMarkerIndex);
  if (triggerIndex === -1) return null;

  const lineStart = lineStartBefore(comment, triggerIndex);
  return {
    question: extractQuestion(comment.slice(lineStart)),
    original,
    priorThread: comment.slice(0, lineStart).trim(),
  };
}

function sanitizeAnswerText(text: string): string {
  // Claude's own answer can quote the trigger literally (discussing "@claude"
  // itself); left intact it would look like a new pending ask to parseAsk.
  return text.replace(globalTrigger(), (match) => match.slice(1));
}

/** Just the appended Claude block for a state, without the original comment. */
export function renderAskBlock(state: AskState): string {
  switch (state.kind) {
    case "pending":
      return PENDING_BLOCK;
    case "answered":
      return `\n\nClaude:\n${sanitizeAnswerText(state.text)}`;
    case "failed":
      return `\n\nClaude: 실패 (${state.reason}). 이 블록을 지우고 Enter를 누르면 다시 시도합니다.`;
  }
}

export function renderComment(original: string, state: AskState): string {
  return `${original}${renderAskBlock(state)}`;
}

function replaceLast(
  haystack: string,
  needle: string,
  replacement: string,
): string {
  const index = haystack.lastIndexOf(needle);
  if (index === -1) return haystack;
  return (
    haystack.slice(0, index) +
    replacement +
    haystack.slice(index + needle.length)
  );
}

/**
 * Zotero's reader autosaves the annotation comment as the user types, so the
 * comment can change between the pending write and the final one landing;
 * this reconciles instead of blindly overwriting.
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
    // A follow-up's pending block is always the newest one; an earlier
    // answered turn can't contain this literal text, but resolve the last
    // match on general principle rather than assuming that.
    return replaceLast(
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
  pdfPath: string | null;
  /** Earlier questions and answers on this same highlight, for a follow-up asked in a new Claude session. */
  priorThread?: string;
}): string {
  const location = params.pageLabel ? ` (page ${params.pageLabel})` : "";
  const wherePages = params.pageLabel
    ? `the pages around page ${params.pageLabel} (where the highlight sits)`
    : "the pages around the highlight";
  const readAround = params.pdfPath
    ? ` The paper's PDF is at ${params.pdfPath}. If you have not already read ${wherePages} earlier in this conversation, read them now for surrounding context — do not rely on the quoted snippet alone.`
    : "";
  const priorThreadLines = params.priorThread
    ? [
        ``,
        `These are earlier questions and answers on this same highlight:`,
        `"""`,
        params.priorThread,
        `"""`,
      ]
    : [];
  return [
    `You are answering a question about a highlighted passage from the paper "${params.title}"${location}.`,
    `Highlighted passage:`,
    `"""`,
    params.highlight,
    `"""`,
    `Question: ${params.question}`,
    ...priorThreadLines,
    ``,
    `This conversation continues across every @claude question on this paper for as long as its reader tab stays open, so treat earlier questions and answers here as context.`,
    `Answer in Korean. Write plain text only: this answer is written back into a Zotero annotation comment, which does not render Markdown, so do not use Markdown syntax (no #, *, -, backticks, etc). Keep the whole answer under about 1500 characters. Put any URL alone on its own line, and only include a URL you actually retrieved with a web tool during this turn; never invent one.${readAround} Output only the answer text itself, with no preamble, labels, or restatement of the question.`,
  ].join("\n");
}
