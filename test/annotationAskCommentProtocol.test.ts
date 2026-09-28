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
          "@claude 이게 뭐야?\n\nClaude: 실패 (오류). 이 블록을 지우고 Enter를 누르면 다시 시도합니다.",
        ),
      );
    });

    it("right-trims trailing whitespace from the original", function () {
      const result = parseAsk("@claude 이게 뭐야?   \n  ");
      assert.equal(result?.original, "@claude 이게 뭐야?");
    });

    it("parses a follow-up asked after an earlier answer, carrying priorThread", function () {
      const comment =
        "@claude 이거 데이터는 어변 작성 중...\n\nClaude:\n이 부분은 ... 말씀해 주세요.\n\n@claude 그러면 데이터셋은 어떻게 모은거야? 오픈소스 데이터셋이야?";
      const result = parseAsk(comment);
      assert.equal(
        result?.question,
        "그러면 데이터셋은 어떻게 모은거야? 오픈소스 데이터셋이야?",
      );
      assert.isTrue(result?.priorThread?.startsWith("@claude 이거 데이터는"));
      assert.isTrue(result?.priorThread?.endsWith("말씀해 주세요."));
    });

    it("returns null when the comment ends right after the answer, with no follow-up", function () {
      const comment =
        "@claude 이거 데이터는 어변 작성 중...\n\nClaude:\n이 부분은 ... 말씀해 주세요.";
      assert.isNull(parseAsk(comment));
    });

    it("takes the whole line as the question when the trigger sits mid-line", function () {
      const comment =
        "@claude 원래 질문\n\nClaude:\n답변입니다.\n\n그러면 @claude 이건?";
      const result = parseAsk(comment);
      assert.equal(result?.question, "그러면 이건?");
    });

    it("returns null while a pending block sits at the end", function () {
      const comment =
        "@claude 원래 질문\n\nClaude:\n답변입니다.\n\n@claude 다음 질문\n\nClaude: 답변 작성 중...";
      assert.isNull(parseAsk(comment));
    });

    it("parses the earlier ask again once its failed block is deleted", function () {
      const withFailedBlock =
        "@claude 원래 질문\n\nClaude:\n답변입니다.\n\n@claude 다음 질문\n\nClaude: 실패 (오류). 이 블록을 지우고 Enter를 누르면 다시 시도합니다.";
      assert.isNull(parseAsk(withFailedBlock));

      const failedBlockDeleted =
        "@claude 원래 질문\n\nClaude:\n답변입니다.\n\n@claude 다음 질문";
      const result = parseAsk(failedBlockDeleted);
      assert.equal(result?.question, "다음 질문");
      assert.equal(
        result?.priorThread,
        "@claude 원래 질문\n\nClaude:\n답변입니다.",
      );
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
        "@claude 요약해줘\n\nClaude: 실패 (타임아웃). 이 블록을 지우고 Enter를 누르면 다시 시도합니다.",
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
        "\n\nClaude: 실패 (타임아웃). 이 블록을 지우고 Enter를 누르면 다시 시도합니다.",
      );
    });

    it("sanitizes a literal trigger inside the answer text so it never re-arms", function () {
      assert.equal(
        renderAskBlock({
          kind: "answered",
          text: "다시 @claude 라고 부르면 됩니다.",
        }),
        "\n\nClaude:\n다시 claude 라고 부르면 됩니다.",
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
        "@claude 요약해줘 (급함)\n\nClaude: 실패 (타임아웃). 이 블록을 지우고 Enter를 누르면 다시 시도합니다.",
      );
    });

    it("replaces the last pending-like block when the comment carries two", function () {
      assert.equal(
        reconcileFinalComment({
          original,
          currentComment:
            "@claude 요약해줘\n\nClaude: 답변 작성 중...\n\n@claude 추가\n\nClaude: 답변 작성 중...",
          finalState: { kind: "answered", text: "요약입니다." },
        }),
        "@claude 요약해줘\n\nClaude: 답변 작성 중...\n\n@claude 추가\n\nClaude:\n요약입니다.",
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

    it("includes the prior thread as context for a follow-up", function () {
      const prompt = buildPrompt({
        title: "Paper",
        highlight: "text",
        question: "그러면 이건?",
        pdfPath: null,
        priorThread: "@claude 원래 질문\n\nClaude:\n답변입니다.",
      });
      assert.include(
        prompt,
        "earlier questions and answers on this same highlight",
      );
      assert.include(prompt, "@claude 원래 질문\n\nClaude:\n답변입니다.");
    });

    it("omits the prior thread section for a first ask", function () {
      const prompt = buildPrompt({
        title: "Paper",
        highlight: "text",
        question: "q",
        pdfPath: null,
      });
      assert.notInclude(
        prompt,
        "earlier questions and answers on this same highlight",
      );
    });
  });
});
