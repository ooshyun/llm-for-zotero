import { assert } from "chai";
import { editorKeyAction } from "../src/modules/annotationAsk/readerCommentHooks";

function key(
  name: string,
  overrides: Partial<{
    shiftKey: boolean;
    isComposing: boolean;
    keyCode: number;
  }> = {},
) {
  return {
    key: name,
    shiftKey: false,
    isComposing: false,
    keyCode: name === "Enter" ? 13 : 0,
    ...overrides,
  };
}

const closed = (editorText: string) => ({ dropdownOpen: false, editorText });
const open = { dropdownOpen: true, editorText: "@cl" };

describe("annotationAsk/readerCommentHooks editorKeyAction", function () {
  it("submits on Enter in a comment that asks, and keeps Shift+Enter a newline", function () {
    assert.equal(
      editorKeyAction(key("Enter"), closed("@claude 이게 뭐야?")),
      "submit",
    );
    assert.isNull(
      editorKeyAction(
        key("Enter", { shiftKey: true }),
        closed("@claude 이게 뭐야?"),
      ),
    );
  });

  it("leaves Enter alone while an IME is composing", function () {
    assert.isNull(
      editorKeyAction(
        key("Enter", { isComposing: true }),
        closed("@claude 이게 뭐"),
      ),
    );
    assert.isNull(
      editorKeyAction(
        key("Enter", { keyCode: 229 }),
        closed("@claude 이게 뭐"),
      ),
    );
    assert.isNull(editorKeyAction(key("Enter", { isComposing: true }), open));
    assert.equal(
      editorKeyAction(key("Enter"), closed("@claude 이게 뭐")),
      "submit",
    );
  });

  it("leaves Enter alone in a comment that does not ask", function () {
    assert.isNull(editorKeyAction(key("Enter"), closed("just a note")));
    assert.isNull(
      editorKeyAction(key("Enter"), closed("@claude 뭐야?\n\nClaude:\n답변")),
    );
    assert.equal(
      editorKeyAction(key("Enter"), closed("@claude 뭐야?")),
      "submit",
    );
  });

  it("drives the open mention dropdown instead of submitting", function () {
    assert.equal(editorKeyAction(key("Enter"), open), "pick");
    assert.equal(editorKeyAction(key("Tab"), open), "pick");
    assert.equal(editorKeyAction(key("ArrowDown"), open), "next");
    assert.equal(editorKeyAction(key("ArrowUp"), open), "previous");
    assert.equal(editorKeyAction(key("Escape"), open), "close");
    assert.isNull(editorKeyAction(key("Tab"), closed("@cl")));
  });
});
