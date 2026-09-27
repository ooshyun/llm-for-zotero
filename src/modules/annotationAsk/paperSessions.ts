import { RUNTIME_CONVERSATION_KEY_END } from "../../shared/conversationKeySpace";

export const CONVERSATION_KEY_BASE =
  RUNTIME_CONVERSATION_KEY_END + 2_000_000_000_000_000;

export type PaperSession = {
  attachmentId: number;
  conversationKey: number;
};

const sessions = new Map<number, PaperSession>();

// Seeded from Date.now() (not from zero) so a key allocated after a plugin
// restart never repeats one a still-running bridge session might resume.
let nextKeyOffset = Date.now();

function allocateConversationKey(): number {
  nextKeyOffset += 1;
  return CONVERSATION_KEY_BASE + nextKeyOffset;
}

export function openPaperSession(attachmentId: number): PaperSession {
  const session: PaperSession = {
    attachmentId,
    conversationKey: allocateConversationKey(),
  };
  sessions.set(attachmentId, session);
  return session;
}

export function closePaperSession(attachmentId: number): void {
  sessions.delete(attachmentId);
}

/**
 * The reader tab that owns this attachment may have opened before the
 * plugin started, or the annotation may have arrived through the API with
 * no tab at all, so a missing session is opened on first use rather than
 * treated as an error.
 */
export function sessionFor(attachmentId: number): PaperSession {
  return sessions.get(attachmentId) || openPaperSession(attachmentId);
}

export function resetPaperSessionsForTests(): void {
  sessions.clear();
  nextKeyOffset = Date.now();
}
