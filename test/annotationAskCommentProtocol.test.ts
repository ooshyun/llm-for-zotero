import { assert } from "chai";
import {
  buildPrompt,
  parseAsk,
  reconcileFinalComment,
  renderAskBlock,
  renderComment,
} from "../src/modules/annotationAsk/commentProtocol";

describe("annotationAsk/commentProtocol", function () {
  describe("parseAsk", function () {
    it("returns null for a plain comment with no trigger", function () {
      assert.isNull(parseAsk("just a note"));
    });

    it("extracts the question after the trigger", function () {
      const result = parseAsk("@claude 이게 뭐야?");
      assert.deepEqual(result, {
        question: "이게 뭐야?",
        original: "@claude 이게 뭐야?",
      });
    });

    it("defaults the question when nothing follows the trigger", function () {
      const result = parseAsk("@claude");
      assert.deepEqual(result, {
        question: "이 부분을 설명해줘.",
        original: "@claude",
      });
    });

    it("returns null when the answer marker is already present", function () {
      assert.isNull(parseAsk("@claude 이게 뭐야?\n\nClaude: 답변 작성 중..."));
      assert.isNull(
        parseAsk("@claude 이게 뭐야?\n\nClaude:\n이미 답변했어요."),
      );
      assert.isNull(
        parseAsk(
          "@claude 이게 뭐야?\n\nClaude: 실패 (오류). 이 블록을 지우면 다시 시도합니다.",
        ),
      );
    });

    it("right-trims trailing whitespace from the original", function () {
      const result = parseAsk("@claude 이게 뭐야?   \n  ");
      assert.equal(result?.original, "@claude 이게 뭐야?");
    });
  });

  describe("renderComment", function () {
    const original = "@claude 요약해줘";

    it("renders the pending state", function () {
      assert.equal(
        renderComment(original, { kind: "pending" }),
        "@claude 요약해줘\n\nClaude: 답변 작성 중...",
      );
    });

    it("renders the answered state", function () {
      assert.equal(
        renderComment(original, { kind: "answered", text: "요약입니다." }),
        "@claude 요약해줘\n\nClaude:\n요약입니다.",
      );
    });

    it("renders the failed state", function () {
      assert.equal(
        renderComment(original, { kind: "failed", reason: "타임아웃" }),
        "@claude 요약해줘\n\nClaude: 실패 (타임아웃). 이 블록을 지우면 다시 시도합니다.",
      );
    });
  });

  describe("renderAskBlock", function () {
    it("renders just the appended block for each state", function () {
      assert.equal(
        renderAskBlock({ kind: "pending" }),
        "\n\nClaude: 답변 작성 중...",
      );
      assert.equal(
        renderAskBlock({ kind: "answered", text: "요약입니다." }),
        "\n\nClaude:\n요약입니다.",
      );
      assert.equal(
        renderAskBlock({ kind: "failed", reason: "타임아웃" }),
        "\n\nClaude: 실패 (타임아웃). 이 블록을 지우면 다시 시도합니다.",
      );
    });
  });

  describe("reconcileFinalComment", function () {
    const original = "@claude 요약해줘";
    const pendingComment = "@claude 요약해줘\n\nClaude: 답변 작성 중...";

    it("renders normally when the comment is unchanged since the pending write", function () {
      assert.equal(
        reconcileFinalComment({
          original,
          currentComment: pendingComment,
          finalState: { kind: "answered", text: "요약입니다." },
        }),
        "@claude 요약해줘\n\nClaude:\n요약입니다.",
      );
    });

    it("replaces only the pending block when the user edited around it", function () {
      assert.equal(
        reconcileFinalComment({
          original,
          currentComment: "@claude 요약해줘 (급함)\n\nClaude: 답변 작성 중...",
          finalState: { kind: "answered", text: "요약입니다." },
        }),
        "@claude 요약해줘 (급함)\n\nClaude:\n요약입니다.",
      );
    });

    it("appends the block when the pending block is gone entirely", function () {
      assert.equal(
        reconcileFinalComment({
          original,
          currentComment: "@claude 요약해줘 그리고 결론도",
          finalState: { kind: "answered", text: "요약입니다." },
        }),
        "@claude 요약해줘 그리고 결론도\n\nClaude:\n요약입니다.",
      );
    });

    it("reconciles a failed state the same way", function () {
      assert.equal(
        reconcileFinalComment({
          original,
          currentComment: "@claude 요약해줘 (급함)\n\nClaude: 답변 작성 중...",
          finalState: { kind: "failed", reason: "타임아웃" },
        }),
        "@claude 요약해줘 (급함)\n\nClaude: 실패 (타임아웃). 이 블록을 지우면 다시 시도합니다.",
      );
    });
  });

  describe("buildPrompt", function () {
    it("includes the title, highlight, and question", function () {
      const prompt = buildPrompt({
        title: "Attention Is All You Need",
        pageLabel: "3",
        highlight: "scaled dot-product attention",
        question: "이게 뭐야?",
        pdfPath: "/papers/attention.pdf",
      });
      assert.include(prompt, "Attention Is All You Need");
      assert.include(prompt, "scaled dot-product attention");
      assert.include(prompt, "이게 뭐야?");
      assert.include(prompt, "page 3");
      assert.include(prompt, "Korean");
    });

    it("tells Claude the PDF path and to read the pages around the highlight's page", function () {
      const prompt = buildPrompt({
        title: "Paper",
        pageLabel: "7",
        highlight: "text",
        question: "q",
        pdfPath: "/papers/attention.pdf",
      });
      assert.include(prompt, "/papers/attention.pdf");
      assert.include(prompt, "the pages around page 7");
    });

    it("says the conversation continues across highlights in the same paper", function () {
      const prompt = buildPrompt({
        title: "Paper",
        highlight: "text",
        question: "q",
        pdfPath: "/papers/attention.pdf",
      });
      assert.include(prompt, "continues across every @claude question");
    });

    it("omits the PDF path instruction when the path cannot be resolved", function () {
      const prompt = buildPrompt({
        title: "Paper",
        highlight: "text",
        question: "q",
        pdfPath: null,
      });
      assert.notInclude(prompt, "PDF is at");
    });

    it("omits the page label when absent", function () {
      const prompt = buildPrompt({
        title: "Paper",
        highlight: "text",
        question: "q",
        pdfPath: null,
      });
      assert.notInclude(prompt, "(page");
    });
  });
});
