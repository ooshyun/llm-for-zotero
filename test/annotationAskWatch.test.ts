import { assert } from "chai";
import {
  handleAnnotationAskNotificationForTests,
  resetAnnotationAskWatchForTests,
  setAnnotationAskDebounceMsForTests,
  setAnnotationAskTurnRunnerForTests,
} from "../src/modules/annotationAsk/watch";
import type { AnnotationAskTurnInput } from "../src/modules/annotationAsk/turnRunner";

const TEST_DEBOUNCE_MS = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Long enough for the debounce timer to fire and the queued turn to settle. */
async function waitPastDebounce(): Promise<void> {
  await sleep(TEST_DEBOUNCE_MS + 40);
}

type MockItem = {
  id: number;
  libraryID: number;
  parentID?: number;
  itemType?: string;
  isAttachment: () => boolean;
  isRegularItem?: () => boolean;
  isAnnotation?: () => boolean;
  attachmentContentType?: string;
  annotationType?: string;
  annotationText?: string;
  annotationComment?: string;
  annotationPageLabel?: string;
  getField?: (field: string) => string;
  saveTx: () => Promise<void>;
};

function createParent(id = 301): MockItem {
  return {
    id,
    libraryID: 1,
    itemType: "journalArticle",
    isAttachment: () => false,
    isRegularItem: () => true,
    getField: (field) => (field === "title" ? "Attention Is All You Need" : ""),
    saveTx: async () => {},
  };
}

function createPdf(id = 302, parentID = 301): MockItem {
  return {
    id,
    libraryID: 1,
    parentID,
    itemType: "attachment",
    attachmentContentType: "application/pdf",
    isAttachment: () => true,
    isRegularItem: () => false,
    getField: () => "",
    saveTx: async () => {},
  };
}

function createAnnotation(
  id = 303,
  parentID = 302,
  comment = "@claude 요약해줘",
): MockItem {
  return {
    id,
    libraryID: 1,
    parentID,
    itemType: "annotation",
    isAttachment: () => false,
    isAnnotation: () => true,
    annotationType: "highlight",
    annotationText: "scaled dot-product attention",
    annotationComment: comment,
    annotationPageLabel: "3",
    saveTx: async () => {},
  };
}

function setupZotero(
  items: Map<number, MockItem>,
  options: {
    claudeCodeModeEnabled?: boolean;
    annotationAskEnabled?: boolean;
  } = {},
): void {
  const claudeCodeModeEnabled = options.claudeCodeModeEnabled ?? true;
  const annotationAskEnabled = options.annotationAskEnabled ?? true;
  (globalThis as unknown as { Zotero: unknown }).Zotero = {
    Items: {
      get: (id: number) => items.get(id) || null,
    },
    Prefs: {
      get: (key: string) => {
        if (key.endsWith(".enableClaudeCodeMode")) return claudeCodeModeEnabled;
        if (key.endsWith(".annotationAskEnabled")) return annotationAskEnabled;
        return "";
      },
      set: () => {},
    },
  };
}

describe("annotationAsk/watch", function () {
  beforeEach(function () {
    setAnnotationAskDebounceMsForTests(TEST_DEBOUNCE_MS);
  });

  afterEach(function () {
    resetAnnotationAskWatchForTests();
    delete (globalThis as unknown as { Zotero?: unknown }).Zotero;
  });

  it("answers a fresh @claude annotation comment and writes it back", async function () {
    const parent = createParent();
    const pdf = createPdf();
    const annotation = createAnnotation();
    const items = new Map<number, MockItem>([
      [parent.id, parent],
      [pdf.id, pdf],
      [annotation.id, annotation],
    ]);
    setupZotero(items);

    const calls: AnnotationAskTurnInput[] = [];
    setAnnotationAskTurnRunnerForTests(async (input) => {
      calls.push(input);
      return "요약입니다.";
    });

    handleAnnotationAskNotificationForTests("modify", "item", [annotation.id]);
    await waitPastDebounce();

    assert.equal(
      annotation.annotationComment,
      "@claude 요약해줘\n\nClaude:\n요약입니다.",
    );
    assert.lengthOf(calls, 1);
    assert.equal(calls[0].highlight, "scaled dot-product attention");
    assert.equal(calls[0].question, "요약해줘");
    assert.equal(calls[0].title, "Attention Is All You Need");

    calls.length = 0;
    handleAnnotationAskNotificationForTests("modify", "item", [annotation.id]);
    await waitPastDebounce();
    assert.lengthOf(calls, 0);
    assert.equal(
      annotation.annotationComment,
      "@claude 요약해줘\n\nClaude:\n요약입니다.",
    );
  });

  it("writes a failed state when the runner throws", async function () {
    const parent = createParent();
    const pdf = createPdf();
    const annotation = createAnnotation();
    const items = new Map<number, MockItem>([
      [parent.id, parent],
      [pdf.id, pdf],
      [annotation.id, annotation],
    ]);
    setupZotero(items);

    setAnnotationAskTurnRunnerForTests(async () => {
      throw new Error("bridge unreachable");
    });

    handleAnnotationAskNotificationForTests("modify", "item", [annotation.id]);
    await waitPastDebounce();

    assert.equal(
      annotation.annotationComment,
      "@claude 요약해줘\n\nClaude: 실패 (bridge unreachable). 이 블록을 지우면 다시 시도합니다.",
    );
  });

  it("does not call the runner and leaves the comment untouched when the pref is off", async function () {
    const parent = createParent();
    const pdf = createPdf();
    const annotation = createAnnotation();
    const items = new Map<number, MockItem>([
      [parent.id, parent],
      [pdf.id, pdf],
      [annotation.id, annotation],
    ]);
    setupZotero(items, { annotationAskEnabled: false });

    let called = false;
    setAnnotationAskTurnRunnerForTests(async () => {
      called = true;
      return "unused";
    });

    handleAnnotationAskNotificationForTests("modify", "item", [annotation.id]);
    await waitPastDebounce();

    assert.isFalse(called);
    assert.equal(annotation.annotationComment, "@claude 요약해줘");
  });

  it("does not call the runner when Claude Code mode is disabled", async function () {
    const parent = createParent();
    const pdf = createPdf();
    const annotation = createAnnotation();
    const items = new Map<number, MockItem>([
      [parent.id, parent],
      [pdf.id, pdf],
      [annotation.id, annotation],
    ]);
    setupZotero(items, { claudeCodeModeEnabled: false });

    let called = false;
    setAnnotationAskTurnRunnerForTests(async () => {
      called = true;
      return "unused";
    });

    handleAnnotationAskNotificationForTests("modify", "item", [annotation.id]);
    await waitPastDebounce();

    assert.isFalse(called);
    assert.equal(annotation.annotationComment, "@claude 요약해줘");
  });

  it("ignores a comment with no @claude trigger", async function () {
    const parent = createParent();
    const pdf = createPdf();
    const annotation = createAnnotation(303, 302, "just a note");
    const items = new Map<number, MockItem>([
      [parent.id, parent],
      [pdf.id, pdf],
      [annotation.id, annotation],
    ]);
    setupZotero(items);

    let called = false;
    setAnnotationAskTurnRunnerForTests(async () => {
      called = true;
      return "unused";
    });

    handleAnnotationAskNotificationForTests("add", "item", [annotation.id]);
    await waitPastDebounce();

    assert.isFalse(called);
    assert.equal(annotation.annotationComment, "just a note");
  });

  it("ignores annotations on a non-PDF attachment", async function () {
    const parent = createParent();
    const nonPdf = createPdf(302, 301);
    nonPdf.attachmentContentType = "text/html";
    const annotation = createAnnotation();
    const items = new Map<number, MockItem>([
      [parent.id, parent],
      [nonPdf.id, nonPdf],
      [annotation.id, annotation],
    ]);
    setupZotero(items);

    let called = false;
    setAnnotationAskTurnRunnerForTests(async () => {
      called = true;
      return "unused";
    });

    handleAnnotationAskNotificationForTests("add", "item", [annotation.id]);
    await waitPastDebounce();

    assert.isFalse(called);
  });

  it("answers a note annotation with empty annotationText", async function () {
    const parent = createParent();
    const pdf = createPdf();
    const annotation = createAnnotation();
    annotation.annotationType = "note";
    annotation.annotationText = "";
    const items = new Map<number, MockItem>([
      [parent.id, parent],
      [pdf.id, pdf],
      [annotation.id, annotation],
    ]);
    setupZotero(items);

    setAnnotationAskTurnRunnerForTests(async () => "노트 답변");

    handleAnnotationAskNotificationForTests("modify", "item", [annotation.id]);
    await waitPastDebounce();

    assert.equal(
      annotation.annotationComment,
      "@claude 요약해줘\n\nClaude:\n노트 답변",
    );
  });

  it("debounces rapid modifies while the user is still typing, answering only the settled question", async function () {
    const parent = createParent();
    const pdf = createPdf();
    const annotation = createAnnotation(303, 302, "@claude 이");
    const items = new Map<number, MockItem>([
      [parent.id, parent],
      [pdf.id, pdf],
      [annotation.id, annotation],
    ]);
    setupZotero(items);

    const calls: AnnotationAskTurnInput[] = [];
    setAnnotationAskTurnRunnerForTests(async (input) => {
      calls.push(input);
      return "이건 셀프 어텐션입니다.";
    });

    // First keystroke-driven autosave: a half-typed question.
    handleAnnotationAskNotificationForTests("modify", "item", [annotation.id]);
    await sleep(TEST_DEBOUNCE_MS / 2);

    // Still well within the debounce window: this restarts the timer instead
    // of stacking a second turn, and only the settled text is ever read.
    annotation.annotationComment = "@claude 이게 뭐야?";
    handleAnnotationAskNotificationForTests("modify", "item", [annotation.id]);

    await waitPastDebounce();

    assert.lengthOf(calls, 1);
    assert.equal(calls[0].question, "이게 뭐야?");
    assert.equal(
      annotation.annotationComment,
      "@claude 이게 뭐야?\n\nClaude:\n이건 셀프 어텐션입니다.",
    );
  });

  it("preserves an edit made while the turn was in flight instead of clobbering it", async function () {
    const parent = createParent();
    const pdf = createPdf();
    const annotation = createAnnotation();
    const items = new Map<number, MockItem>([
      [parent.id, parent],
      [pdf.id, pdf],
      [annotation.id, annotation],
    ]);
    setupZotero(items);

    setAnnotationAskTurnRunnerForTests(async () => {
      // Simulate the user typing more into the comment while the turn is
      // still running — Zotero's own autosave, arriving mid-flight.
      annotation.annotationComment =
        "@claude 요약해줘 (급함)\n\nClaude: 답변 작성 중...";
      return "요약입니다.";
    });

    handleAnnotationAskNotificationForTests("modify", "item", [annotation.id]);
    await waitPastDebounce();

    assert.equal(
      annotation.annotationComment,
      "@claude 요약해줘 (급함)\n\nClaude:\n요약입니다.",
    );
  });
});
