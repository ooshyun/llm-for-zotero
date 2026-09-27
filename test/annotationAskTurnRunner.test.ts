import { assert } from "chai";
import { buildAnnotationAskRequest } from "../src/modules/annotationAsk/turnRunner";
import { resetPaperSessionsForTests } from "../src/modules/annotationAsk/paperSessions";
import type { PaperContextRef } from "../src/shared/types";

function paperContext(
  overrides: Partial<PaperContextRef> = {},
): PaperContextRef {
  return {
    libraryID: 1,
    itemId: 301,
    contextItemId: 302,
    title: "Attention Is All You Need",
    ...overrides,
  };
}

describe("annotationAsk/turnRunner buildAnnotationAskRequest", function () {
  beforeEach(function () {
    (globalThis as unknown as { Zotero: unknown }).Zotero = {
      Prefs: {
        get: () => "",
        set: () => {},
      },
    };
    resetPaperSessionsForTests();
  });

  afterEach(function () {
    delete (globalThis as unknown as { Zotero?: unknown }).Zotero;
    resetPaperSessionsForTests();
  });

  it("carries the resolved PDF path in the prompt text with no localDocuments", async function () {
    const request = await buildAnnotationAskRequest(
      {
        title: "Attention Is All You Need",
        pageLabel: "3",
        highlight: "scaled dot-product attention",
        question: "이게 뭐야?",
        paperContext: paperContext(),
      },
      { resolvePdfPath: async () => "/papers/attention.pdf" },
    );

    assert.isUndefined(request.localDocuments);
    assert.isUndefined(request.pdfPaperContexts);
    assert.include(request.userText, "/papers/attention.pdf");
    assert.equal(request.activePaperContext?.itemId, 301);
  });

  it("omits the read-the-PDF instruction when the path cannot be resolved", async function () {
    const request = await buildAnnotationAskRequest(
      {
        title: "Attention Is All You Need",
        highlight: "scaled dot-product attention",
        question: "이게 뭐야?",
        paperContext: paperContext(),
      },
      { resolvePdfPath: async () => null },
    );

    assert.isUndefined(request.localDocuments);
    assert.notInclude(request.userText, "PDF is at");
    assert.equal(request.activePaperContext?.itemId, 301);
  });

  it("uses the same conversation key across two requests for the same attachment", async function () {
    const first = await buildAnnotationAskRequest(
      {
        title: "Paper",
        highlight: "text one",
        question: "q1",
        paperContext: paperContext(),
      },
      { resolvePdfPath: async () => "/papers/attention.pdf" },
    );
    const second = await buildAnnotationAskRequest(
      {
        title: "Paper",
        highlight: "text two",
        question: "q2",
        paperContext: paperContext(),
      },
      { resolvePdfPath: async () => "/papers/attention.pdf" },
    );

    assert.equal(first.conversationKey, second.conversationKey);
  });

  it("refuses a paper context with no active library", async function () {
    try {
      await buildAnnotationAskRequest(
        {
          title: "Paper",
          highlight: "text",
          question: "q",
          paperContext: paperContext({ libraryID: undefined }),
        },
        { resolvePdfPath: async () => null },
      );
      assert.fail("expected rejection");
    } catch (error) {
      assert.include(
        error instanceof Error ? error.message : String(error),
        "active Zotero library",
      );
    }
  });
});
