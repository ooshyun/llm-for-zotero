import { appLogger } from "../../core/logging";
import { getAllOpenReaders } from "../../services/pdf/zoteroReaderTabs";
import { parseAsk } from "./commentProtocol";
import {
  matchMentionAgents,
  parseMentionQuery,
  type MentionAgent,
  type MentionQuery,
} from "./mentionAgents";

export type CommentHookHost = {
  isActive: () => boolean;
  /** `comment` is what the reader will save for the annotation, when known. */
  submit: (annotationItemId: number, comment: string | null) => void;
};

type ReaderLike = {
  _item?: { libraryID?: number };
  _iframe?: EventTarget;
  _iframeWindow?: Window;
  _initPromise?: Promise<unknown>;
  _internalReader?: {
    _annotationManager?: {
      _getAnnotationByID?: (id: string) => { comment?: string } | undefined;
    };
  };
};

type EditorKey = {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode: number;
};

export type EditorKeyAction = "submit" | "pick" | "next" | "previous" | "close";

/** What a keydown in an annotation comment editor should do, if anything. */
export function editorKeyAction(
  event: EditorKey,
  state: { dropdownOpen: boolean; editorText: string },
): EditorKeyAction | null {
  // 229 is the keyCode of a keydown an IME consumes, such as the Enter that
  // commits a Korean syllable.
  if (event.isComposing || event.keyCode === 229) return null;
  if (state.dropdownOpen) {
    switch (event.key) {
      case "ArrowDown":
        return "next";
      case "ArrowUp":
        return "previous";
      case "Enter":
      case "Tab":
        return event.shiftKey ? null : "pick";
      case "Escape":
        return "close";
    }
  }
  if (event.key !== "Enter" || event.shiftKey) return null;
  return parseAsk(state.editorText) ? "submit" : null;
}

const EDITOR_SELECTOR = '.comment .content[contenteditable="true"]';
const TAB_READER_WAIT_MS = 5000;

let host: CommentHookHost | null = null;
const attachedDocs = new WeakSet<Document>();
const detachers = new Set<() => void>();

function findEditor(target: EventTarget | null): HTMLElement | null {
  const element = target as Element | null;
  return (element?.closest?.(EDITOR_SELECTOR) as HTMLElement | null) ?? null;
}

type Dropdown = {
  element: HTMLElement;
  agents: MentionAgent[];
  index: number;
};

function attachToReader(reader: ReaderLike): void {
  const win = reader._iframeWindow;
  const doc = win?.document;
  const frame = reader._iframe;
  if (!win || !doc || !frame || attachedDocs.has(doc)) return;
  attachedDocs.add(doc);

  let composing = false;
  let dropdown: Dropdown | null = null;

  const closeDropdown = () => {
    dropdown?.element.remove();
    dropdown = null;
  };

  const mentionAtCaret = (): {
    node: Text;
    offset: number;
    mention: MentionQuery;
  } | null => {
    const selection = win.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    if (range.startContainer.nodeType !== 3) return null;
    const node = range.startContainer as Text;
    const offset = range.startOffset;
    const mention = parseMentionQuery(node.data.slice(0, offset));
    return mention ? { node, offset, mention } : null;
  };

  const renderDropdown = (agents: MentionAgent[], index: number) => {
    let element = dropdown?.element;
    if (!element) {
      element = doc.createElement("div");
      element.className = "llm-mention-dropdown";
      element.setAttribute("role", "listbox");
      element.style.cssText = [
        "position: fixed",
        "z-index: 2147483647",
        "min-width: 220px",
        "max-width: 360px",
        "padding: 4px",
        "border-radius: 6px",
        "border: var(--material-border, 1px solid rgba(128, 128, 128, 0.4))",
        "background: var(--material-background, Canvas)",
        "color: var(--fill-primary, CanvasText)",
        "box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25)",
        "font: message-box",
        "font-size: 12px",
      ].join(";");
      doc.body.append(element);
    }
    element.replaceChildren(
      ...agents.map((agent, i) => {
        const selected = i === index;
        const row = doc.createElement("div");
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(selected));
        row.style.cssText = [
          "display: flex",
          "gap: 8px",
          "align-items: baseline",
          "padding: 4px 8px",
          "border-radius: 4px",
          "cursor: default",
          "white-space: nowrap",
          selected
            ? "background: var(--accent-blue, Highlight); color: var(--accent-white, HighlightText)"
            : "",
        ].join(";");
        const handle = doc.createElement("strong");
        handle.textContent = `@${agent.handle}`;
        const label = doc.createElement("span");
        label.textContent = agent.label;
        const description = doc.createElement("span");
        description.textContent = agent.description;
        description.style.cssText =
          "opacity: 0.7; overflow: hidden; text-overflow: ellipsis";
        row.append(handle, label, description);
        row.addEventListener("mousedown", (event) => {
          event.preventDefault();
          if (dropdown) dropdown.index = i;
          pickAgent();
        });
        return row;
      }),
    );
    dropdown = { element, agents, index };
  };

  const placeDropdown = (anchor: DOMRect) => {
    if (!dropdown) return;
    const { element } = dropdown;
    const height = element.offsetHeight;
    const below = anchor.bottom + 4;
    const top =
      below + height > win.innerHeight ? anchor.top - height - 4 : below;
    const left = Math.min(
      anchor.left,
      win.innerWidth - element.offsetWidth - 4,
    );
    element.style.top = `${Math.max(4, top)}px`;
    element.style.left = `${Math.max(4, left)}px`;
  };

  const refreshDropdown = (editor: HTMLElement) => {
    const caret = mentionAtCaret();
    const agents = caret ? matchMentionAgents(caret.mention.query) : [];
    if (!caret || !agents.length) {
      closeDropdown();
      return;
    }
    renderDropdown(agents, 0);
    const range = doc.createRange();
    range.setStart(caret.node, caret.offset);
    const rect = range.getBoundingClientRect();
    placeDropdown(rect.height ? rect : editor.getBoundingClientRect());
  };

  const pickAgent = (): void => {
    const agent = dropdown?.agents[dropdown.index];
    const caret = mentionAtCaret();
    closeDropdown();
    if (!agent || !caret) return;
    const range = doc.createRange();
    range.setStart(caret.node, caret.mention.start);
    range.setEnd(caret.node, caret.offset);
    const selection = win.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    // insertText goes through the editor's own input handling, so the reader
    // saves the completed handle like any typed text.
    doc.execCommand("insertText", false, `@${agent.handle} `);
  };

  const submit = (editor: HTMLElement) => {
    const key = editor.id;
    const libraryID = reader._item?.libraryID;
    if (!key || libraryID === undefined) return;
    const item = Zotero.Items.getByLibraryAndKey(libraryID, key) as
      | { id: number }
      | false;
    if (!item) return;
    let comment: string | null = null;
    try {
      comment =
        reader._internalReader?._annotationManager?._getAnnotationByID?.(key)
          ?.comment ?? null;
    } catch {
      comment = null;
    }
    host?.submit(item.id, comment);
  };

  // On the reader's <browser> element, which sees a key before the reader's
  // own window-level handlers do: those move focus on Tab.
  const onKeyDown = (event: Event) => {
    const keyEvent = event as KeyboardEvent;
    const editor = findEditor(keyEvent.target);
    if (!editor || !host?.isActive()) return;
    const action = editorKeyAction(
      {
        key: keyEvent.key,
        shiftKey: keyEvent.shiftKey,
        isComposing: keyEvent.isComposing || composing,
        keyCode: keyEvent.keyCode,
      },
      { dropdownOpen: dropdown !== null, editorText: editor.innerText },
    );
    if (!action) return;
    keyEvent.preventDefault();
    keyEvent.stopPropagation();
    switch (action) {
      case "submit":
        submit(editor);
        return;
      case "pick":
        pickAgent();
        return;
      case "close":
        closeDropdown();
        return;
      case "next":
      case "previous": {
        if (!dropdown) return;
        const count = dropdown.agents.length;
        const step = action === "next" ? 1 : count - 1;
        renderDropdown(dropdown.agents, (dropdown.index + step) % count);
        return;
      }
    }
  };

  const onInput = (event: Event) => {
    const editor = findEditor(event.target);
    if (!editor || composing) return;
    if (!host?.isActive()) {
      closeDropdown();
      return;
    }
    refreshDropdown(editor);
  };

  const onCompositionStart = () => {
    composing = true;
  };

  const onCompositionEnd = (event: Event) => {
    composing = false;
    onInput(event);
  };

  const onFocusOut = (event: Event) => {
    if (findEditor(event.target)) closeDropdown();
  };

  const detach = () => {
    frame.removeEventListener("keydown", onKeyDown, true);
    doc.removeEventListener("input", onInput, true);
    doc.removeEventListener("compositionstart", onCompositionStart, true);
    doc.removeEventListener("compositionend", onCompositionEnd, true);
    doc.removeEventListener("focusout", onFocusOut, true);
    win.removeEventListener("unload", detach);
    closeDropdown();
    attachedDocs.delete(doc);
    detachers.delete(detach);
  };

  frame.addEventListener("keydown", onKeyDown, true);
  doc.addEventListener("input", onInput, true);
  doc.addEventListener("compositionstart", onCompositionStart, true);
  doc.addEventListener("compositionend", onCompositionEnd, true);
  doc.addEventListener("focusout", onFocusOut, true);
  win.addEventListener("unload", detach);
  detachers.add(detach);
}

async function attachWhenReady(reader: ReaderLike): Promise<void> {
  try {
    await reader._initPromise;
    if (host) attachToReader(reader);
  } catch (err) {
    appLogger.warn(
      "Annotation ask: failed to hook the reader comment editor",
      err,
    );
  }
}

/**
 * Zotero announces a reader tab before it registers the reader, so the
 * reader is looked up until it appears.
 */
export async function attachReaderCommentHooksForTab(
  tabId: string,
): Promise<void> {
  const readers = (
    Zotero as unknown as {
      Reader?: { getByTabID?: (id: string) => ReaderLike | undefined };
    }
  ).Reader;
  const deadline = Date.now() + TAB_READER_WAIT_MS;
  while (host && Date.now() < deadline) {
    const reader = readers?.getByTabID?.(tabId);
    if (reader) {
      await attachWhenReady(reader);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export function startReaderCommentHooks(nextHost: CommentHookHost): void {
  host = nextHost;
  for (const reader of getAllOpenReaders() as ReaderLike[]) {
    void attachWhenReady(reader);
  }
}

export function stopReaderCommentHooks(): void {
  host = null;
  for (const detach of [...detachers]) detach();
}
