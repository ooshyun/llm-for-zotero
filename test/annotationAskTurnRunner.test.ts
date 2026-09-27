import { assert } from "chai";
import { buildAnnotationAskRequest } from "../src/modules/annotationAsk/turnRunner";
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
  });

  afterEach(function () {
    delete (globalThis as unknown as { Zotero?: unknown }).Zotero;
  });

  it("carries the stubbed attachment's absolute PDF path as a raw-PDF local document", async function () {
    const request = await buildAnnotationAskRequest(
      {
        title: "Attention Is All You Need",
        pageLabel: "3",
        highlight: "scaled dot-product attention",
        question: "이게 뭐야?",
        paperContext: paperContext(),
        annotationItemId: 303,
      },
      {
        localPdfResolver: {
          resolve: async (paperContexts) =>
            paperContexts.map((paper) =>
              Object.freeze({
                kind: "local_pdf" as const,
                sourceKey:
                  `zotero-pdf:${paper.itemId}:${paper.contextItemId}` as const,
                itemId: paper.itemId,
                contextItemId: paper.contextItemId,
                title: paper.title,
                name: "attention.pdf",
                mimeType: "application/pdf" as const,
                absolutePath: "/papers/attention.pdf",
              }),
            ),
        },
      },
    );

    assert.lengthOf(request.localDocuments || [], 1);
    assert.equal(
      request.localDocuments?.[0].absolutePath,
      "/papers/attention.pdf",
    );
    assert.equal(request.localDocuments?.[0].itemId, 301);
    assert.equal(request.localDocuments?.[0].contextItemId, 302);

    assert.lengthOf(request.pdfPaperContexts || [], 1);
    assert.equal(request.pdfPaperContexts?.[0].contentSourceMode, "pdf");
    assert.equal(request.activePaperContext?.contentSourceMode, "pdf");
  });

  it("falls back to metadata-only context when the resolver cannot find a local PDF", async function () {
    const request = await buildAnnotationAskRequest(
      {
        title: "Attention Is All You Need",
        highlight: "scaled dot-product attention",
        question: "이게 뭐야?",
        paperContext: paperContext(),
        annotationItemId: 303,
      },
      {
        localPdfResolver: {
          resolve: async () => {
            throw new Error("file missing");
          },
        },
      },
    );

    assert.isUndefined(request.localDocuments);
    assert.isUndefined(request.pdfPaperContexts);
    assert.equal(request.activePaperContext?.itemId, 301);
  });

  it("refuses a paper context with no active library", async function () {
    try {
      await buildAnnotationAskRequest(
        {
          title: "Paper",
          highlight: "text",
          question: "q",
          paperContext: paperContext({ libraryID: undefined }),
          annotationItemId: 303,
        },
        { localPdfResolver: { resolve: async () => [] } },
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
