import { assert } from "chai";
import {
  handleAnnotationAskNotificationForTests,
  resetAnnotationAskWatchForTests,
  setAnnotationAskTurnRunnerForTests,
} from "../src/modules/annotationAsk/watch";
import type { AnnotationAskTurnInput } from "../src/modules/annotationAsk/turnRunner";

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

    await handleAnnotationAskNotificationForTests("modify", "item", [
      annotation.id,
    ]);

    assert.equal(
      annotation.annotationComment,
      "@claude 요약해줘\n\nClaude:\n요약입니다.",
    );
    assert.lengthOf(calls, 1);
    assert.equal(calls[0].highlight, "scaled dot-product attention");
    assert.equal(calls[0].question, "요약해줘");
    assert.equal(calls[0].title, "Attention Is All You Need");

    calls.length = 0;
    await handleAnnotationAskNotificationForTests("modify", "item", [
      annotation.id,
    ]);
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

    await handleAnnotationAskNotificationForTests("modify", "item", [
      annotation.id,
    ]);

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

    await handleAnnotationAskNotificationForTests("modify", "item", [
      annotation.id,
    ]);

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

    await handleAnnotationAskNotificationForTests("modify", "item", [
      annotation.id,
    ]);

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

    await handleAnnotationAskNotificationForTests("add", "item", [
      annotation.id,
    ]);

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

    await handleAnnotationAskNotificationForTests("add", "item", [
      annotation.id,
    ]);

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

    await handleAnnotationAskNotificationForTests("modify", "item", [
      annotation.id,
    ]);

    assert.equal(
      annotation.annotationComment,
      "@claude 요약해줘\n\nClaude:\n노트 답변",
    );
  });
});
