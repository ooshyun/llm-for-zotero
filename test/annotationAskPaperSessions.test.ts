import { assert } from "chai";
import {
  closePaperSession,
  openPaperSession,
  resetPaperSessionsForTests,
  sessionFor,
} from "../src/modules/annotationAsk/paperSessions";

describe("annotationAsk/paperSessions", function () {
  afterEach(function () {
    resetPaperSessionsForTests();
  });

  it("opens a session and returns it from sessionFor for the same attachment", function () {
    const opened = openPaperSession(301);
    const found = sessionFor(301);
    assert.equal(found.conversationKey, opened.conversationKey);
    assert.equal(found.attachmentId, 301);
  });

  it("lazily opens a session for an attachment that was never opened", function () {
    const session = sessionFor(404);
    assert.equal(session.attachmentId, 404);
    assert.equal(sessionFor(404).conversationKey, session.conversationKey);
  });

  it("allocates a different key after closing and reopening the same attachment", function () {
    const first = openPaperSession(301);
    closePaperSession(301);
    const second = sessionFor(301);
    assert.notEqual(second.conversationKey, first.conversationKey);
  });

  it("strictly increases the allocated key across opens", function () {
    const first = openPaperSession(301);
    const second = openPaperSession(302);
    const third = openPaperSession(303);
    assert.isAbove(second.conversationKey, first.conversationKey);
    assert.isAbove(third.conversationKey, second.conversationKey);
  });
});
