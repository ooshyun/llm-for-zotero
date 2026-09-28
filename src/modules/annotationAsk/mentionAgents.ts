import { isClaudeCodeModeEnabled } from "../../claudeCode/prefs";

export type MentionAgent = {
  handle: string;
  label: string;
  description: string;
  isAvailable: () => boolean;
};

export const MENTION_AGENTS: readonly MentionAgent[] = [
  {
    handle: "claude",
    label: "Claude",
    description: "Claude Code, continues this paper's session",
    isAvailable: isClaudeCodeModeEnabled,
  },
];

export const MENTION_TRIGGER = new RegExp(
  `@(?:${MENTION_AGENTS.map((agent) => agent.handle).join("|")})\\b`,
  "i",
);

export type MentionQuery = {
  query: string;
  /** Offset of the `@` in the text before the caret. */
  start: number;
};

/** The `@partial` the caret sits right after, when it starts a word. */
export function parseMentionQuery(
  textBeforeCaret: string,
): MentionQuery | null {
  const match = /(?:^|\s)@([\w-]*)$/.exec(textBeforeCaret);
  if (!match) return null;
  const query = match[1];
  return { query, start: textBeforeCaret.length - query.length - 1 };
}

export function matchMentionAgents(query: string): MentionAgent[] {
  const prefix = query.toLowerCase();
  return MENTION_AGENTS.filter(
    (agent) => agent.handle.startsWith(prefix) && agent.isAvailable(),
  );
}
