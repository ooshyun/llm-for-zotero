import { assert } from "chai";
import {
  MENTION_TRIGGER,
  matchMentionAgents,
  parseMentionQuery,
} from "../src/modules/annotationAsk/mentionAgents";

function setClaudeCodeMode(enabled: boolean): void {
  (globalThis as unknown as { Zotero: unknown }).Zotero = {
    Prefs: {
      get: (key: string) =>
        key.endsWith(".enableClaudeCodeMode") ? enabled : "",
    },
  };
}

describe("annotationAsk/mentionAgents", function () {
  afterEach(function () {
    delete (globalThis as unknown as { Zotero?: unknown }).Zotero;
  });

  describe("MENTION_TRIGGER", function () {
    it("matches a registered handle case-insensitively as a whole word", function () {
      assert.isTrue(MENTION_TRIGGER.test("@claude help"));
      assert.isTrue(MENTION_TRIGGER.test("@Claude help"));
      assert.isFalse(MENTION_TRIGGER.test("@claudette help"));
    });
  });

  describe("parseMentionQuery", function () {
    it("finds the partial handle the caret sits after", function () {
      assert.deepEqual(parseMentionQuery("hi @cl"), { query: "cl", start: 3 });
      assert.deepEqual(parseMentionQuery("@"), { query: "", start: 0 });
      assert.deepEqual(parseMentionQuery("line\n@claude"), {
        query: "claude",
        start: 5,
      });
    });

    it("ignores an @ inside a word or already followed by a space", function () {
      assert.isNull(parseMentionQuery("a@b"));
      assert.isNull(parseMentionQuery("@claude "));
      assert.isNull(parseMentionQuery("no mention"));
    });
  });

  describe("matchMentionAgents", function () {
    it("lists available agents whose handle starts with the query", function () {
      setClaudeCodeMode(true);
      assert.deepEqual(
        matchMentionAgents("CL").map((agent) => agent.handle),
        ["claude"],
      );
      assert.deepEqual(
        matchMentionAgents("").map((agent) => agent.handle),
        ["claude"],
      );
      assert.deepEqual(matchMentionAgents("x"), []);
    });

    it("hides an agent whose runtime is not available", function () {
      setClaudeCodeMode(false);
      assert.deepEqual(matchMentionAgents("cl"), []);
      setClaudeCodeMode(true);
      assert.deepEqual(
        matchMentionAgents("cl").map((agent) => agent.handle),
        ["claude"],
      );
    });
  });
});
