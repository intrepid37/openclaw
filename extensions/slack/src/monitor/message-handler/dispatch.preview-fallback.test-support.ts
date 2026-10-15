import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, vi, type Mock } from "vitest";

export const THREAD_TS = "thread-1";
const requireRecord = createRequireRecord("object", "label-not-object");

export function createSlackPlatformError(
  error: string,
  details?: { needed?: string; provided?: string },
) {
  // Mirrors @slack/web-api 7.18.0 platformErrorFromResult: message plus structured result data.
  return Object.assign(new Error(`An API error occurred: ${error}`), {
    code: "slack_webapi_platform_error",
    data: { ok: false, error, ...details },
  });
}

const noop = () => {};
const noopAsync = async () => {};
export function createNativeStreamSession() {
  return {
    channel: "C123",
    threadTs: THREAD_TS,
    stopped: false,
    delivered: true,
    pendingText: "",
  };
}

export function createDraftStreamStub() {
  return {
    update: vi.fn(),
    flush: vi.fn(noopAsync),
    clear: vi.fn(noopAsync),
    discardPending: vi.fn(noopAsync),
    seal: vi.fn(noopAsync),
    stop: vi.fn(noop),
    forceNewMessage: vi.fn(),
    dropDetachedMessages: vi.fn(noopAsync),
    finalizeMessage: vi.fn(async (_messageId: string, editFinal: () => Promise<void>) => {
      await editFinal();
      return true;
    }),
    messageId: (): string | undefined => "171234.567",
    channelId: () => "C123",
  };
}

export function useDraftStream(createSlackDraftStreamMock: Mock) {
  const draftStream = createDraftStreamStub();
  createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
  return draftStream;
}

export function draftUpdateTexts(draftStream: ReturnType<typeof createDraftStreamStub>): string[] {
  return draftStream.update.mock.calls.map(([update]) => {
    if (typeof update === "string") {
      return update;
    }
    return requireRecord(update, "draft update").text as string;
  });
}

export function expectLastDraftUpdateText(
  draftStream: ReturnType<typeof createDraftStreamStub>,
  expected: string,
) {
  expect(draftUpdateTexts(draftStream).at(-1)).toBe(expected);
}
