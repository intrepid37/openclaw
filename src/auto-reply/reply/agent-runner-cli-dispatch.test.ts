// Tests CLI dispatch arguments and runtime selection for agent runner turns.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import {
  claudeBlockStart,
  claudeStreamEvent,
  claudeTextDelta,
  createClaudeParser,
  joinJsonlFrames,
} from "../../agents/cli-output.test-helpers.js";
import { createCliEventHandlers } from "../../agents/cli-runner/execute-events.js";
import {
  buildContext,
  buildToolTracking,
} from "../../agents/cli-runner/execute-events.tool-result-args.test-support.js";
import { clearCliSessionInStore } from "../../agents/cli-session-store.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  emitAgentEvent,
  getAgentEventLifecycleGeneration,
  onAgentEvent,
  resetAgentEventsForTest,
} from "../../infra/agent-events.js";
import type { PartialReplyPayload } from "../get-reply-options.types.js";
import {
  createCliToolSummaryTracker,
  keepCliSessionBindingOnlyWhenReused,
  runCliAgentWithLifecycle as runCliAgentWithLifecycleProduction,
} from "./agent-runner-cli-dispatch.js";

type ProductionLifecycleParams = Parameters<typeof runCliAgentWithLifecycleProduction>[0];
type RunCliAgentWithLifecycleParams = Omit<ProductionLifecycleParams, "runParams"> & {
  runParams: Omit<ProductionLifecycleParams["runParams"], "admittedRunContext">;
};
const runCliAgentWithLifecycle = (params: RunCliAgentWithLifecycleParams) =>
  runCliAgentWithLifecycleProduction({
    ...params,
    runParams: withTestAdmittedRunContext(params.runParams),
  });
function createRunParams(
  runId: string,
  overrides: Partial<RunCliAgentWithLifecycleParams["runParams"]> = {},
): RunCliAgentWithLifecycleParams["runParams"] {
  return {
    sessionId: "session-1",
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp/workspace",
    prompt: "hello",
    provider: "claude-cli",
    model: "claude",
    thinkLevel: "high",
    timeoutMs: 1_000,
    runId,
    ...overrides,
  };
}

type ReasoningTextPayload = Parameters<
  NonNullable<RunCliAgentWithLifecycleParams["onReasoningText"]>
>[0];
type ReasoningProgressPayload = Parameters<
  NonNullable<RunCliAgentWithLifecycleParams["onReasoningProgress"]>
>[0];

const cliDispatchState = vi.hoisted(() => ({
  runCliAgentMock: vi.fn(),
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("../../agents/cli-runner.js", () => ({
  runCliAgent: (...args: unknown[]) => cliDispatchState.runCliAgentMock(...args),
}));

afterEach(() => {
  vi.useRealTimers();
  resetAgentEventsForTest();
  cliDispatchState.runCliAgentMock.mockReset();
});

describe("runCliAgentWithLifecycle", () => {
  it("settles workspace attribution before launching a CLI backend", async () => {
    const entered = createDeferred();
    const baseline = createDeferred();
    cliDispatchState.runCliAgentMock.mockResolvedValueOnce({ payloads: [], meta: {} });
    const pending = runCliAgentWithLifecycle({
      runId: "cli-attribution",
      runParams: createRunParams("cli-attribution", {
        awaitSessionDiffBaseline: async () => {
          entered.resolve();
          await baseline.promise;
        },
      }),
    });
    try {
      await awaitGateBeforeSettlement(entered.promise, pending, "CLI launched before attribution");
      expect(cliDispatchState.runCliAgentMock).not.toHaveBeenCalled();
      baseline.resolve();
      await pending;
      expect(cliDispatchState.runCliAgentMock).toHaveBeenCalledOnce();
    } finally {
      baseline.resolve();
    }
  });

  it("bridges completed CLI compaction lifecycles to reply callbacks", async () => {
    cliDispatchState.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      emitAgentEvent({
        runId: params.runId,
        stream: "compaction",
        data: { phase: "start", backend: "claude-cli" },
      });
      emitAgentEvent({
        runId: params.runId,
        stream: "compaction",
        data: { phase: "end", backend: "claude-cli", completed: false },
      });
      emitAgentEvent({
        runId: params.runId,
        stream: "compaction",
        data: { phase: "start", backend: "claude-cli" },
      });
      emitAgentEvent({
        runId: params.runId,
        stream: "compaction",
        data: { phase: "end", backend: "claude-cli", completed: true },
      });
      return { payloads: [], meta: { durationMs: 1 } };
    });
    const callbacks: string[] = [];

    await runCliAgentWithLifecycle({
      runId: "run-compaction-bridge",
      onCompactionStart: async () => {
        callbacks.push("start");
      },
      onCompactionEnd: async (payload) => {
        callbacks.push(payload?.completed === false ? "incomplete" : "end");
      },
      runParams: createRunParams("run-compaction-bridge", {
        model: "claude-opus-4-8",
      }),
    });

    expect(callbacks).toEqual(["start", "incomplete", "start", "end"]);
  });

  it("normalizes shipped string-step plan events to pending typed steps", async () => {
    cliDispatchState.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      emitAgentEvent({
        runId: params.runId,
        stream: "plan",
        data: {
          phase: "update",
          title: "Plan updated",
          source: "codex-exec",
          steps: ["Inspect", "  ", "Patch"],
        },
      });
      return { payloads: [], meta: { durationMs: 1 } };
    });
    const onPlanUpdate = vi.fn(async () => undefined);

    await runCliAgentWithLifecycle({
      runId: "run-plan-legacy",
      onPlanUpdate,
      runParams: createRunParams("run-plan-legacy", {
        provider: "codex-cli",
        model: "codex",
      }),
    });

    expect(onPlanUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: [
          { step: "Inspect", status: "pending" },
          { step: "Patch", status: "pending" },
        ],
      }),
    );
  });

  it("bridges thinking events to reasoning text and dedupes identical snapshots", async () => {
    cliDispatchState.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      emitAgentEvent({
        runId: params.runId,
        stream: "thinking",
        data: { text: "Thinking", delta: "Thinking", isReasoningSnapshot: true },
      });
      emitAgentEvent({
        runId: params.runId,
        stream: "thinking",
        data: { text: "Thinking", delta: "", isReasoningSnapshot: true },
      });
      emitAgentEvent({
        runId: params.runId,
        stream: "thinking",
        data: { text: "Thinking more", delta: " more", isReasoningSnapshot: true },
      });
      emitAgentEvent({
        runId: params.runId,
        stream: "assistant",
        data: { text: "Visible answer", delta: "Visible answer" },
      });
      return { payloads: [{ text: "Visible answer" }], meta: { durationMs: 1 } };
    });
    const onReasoningText = vi.fn<(payload: ReasoningTextPayload) => Promise<void>>(
      async () => undefined,
    );

    const result = await runCliAgentWithLifecycle({
      runId: "run-thinking-bridge",
      onReasoningText,
      runParams: createRunParams("run-thinking-bridge"),
    });

    expect(onReasoningText).toHaveBeenCalledTimes(2);
    expect(onReasoningText.mock.calls.map((call) => call[0])).toEqual([
      { text: "Thinking", isReasoningSnapshot: true },
      { text: "Thinking more", isReasoningSnapshot: true },
    ]);
    expect(result.payloads).toEqual([
      { text: "Thinking more", isReasoning: true },
      { text: "Visible answer" },
    ]);
  });

  it("stamps onActivity for every delivered bridge event, including reasoning-only progress", async () => {
    cliDispatchState.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      emitAgentEvent({
        runId: params.runId,
        stream: "thinking",
        data: { progressTokens: 50 },
      });
      emitAgentEvent({
        runId: params.runId,
        stream: "thinking",
        data: { progressTokens: 50 },
      });
      emitAgentEvent({
        runId: params.runId,
        stream: "thinking",
        data: { progressTokens: 200 },
      });
      return { payloads: [], meta: { durationMs: 1 } };
    });
    const onActivity = vi.fn();
    const onReasoningProgress = vi.fn<(payload: ReasoningProgressPayload) => Promise<void>>(
      async () => undefined,
    );

    await runCliAgentWithLifecycle({
      runId: "run-activity-reasoning-progress",
      onActivity,
      onReasoningProgress,
      runParams: createRunParams("run-activity-reasoning-progress"),
    });

    // A run in a long pure-reasoning stretch must keep stamping activity, or
    // stale-takeover reclaims it while it is visibly thinking. Stamps are
    // per-event (delivery-independent), so dedupe downstream does not matter.
    expect(onReasoningProgress).toHaveBeenCalledTimes(2);
    expect(onActivity).toHaveBeenCalledTimes(3);
  });

  it("keeps stamping onActivity when bridges are suppressed for silent runs", async () => {
    cliDispatchState.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      emitAgentEvent({
        runId: params.runId,
        stream: "thinking",
        data: { progressTokens: 50 },
      });
      emitAgentEvent({
        runId: params.runId,
        stream: "assistant",
        data: { text: "Silent answer", delta: "Silent answer" },
      });
      emitAgentEvent({
        runId: params.runId,
        stream: "assistant",
        data: { completedText: "Silent answer", assistantMessageIndex: 0 },
      });
      return { payloads: [], meta: { durationMs: 1 } };
    });
    const onActivity = vi.fn();
    const onCompletedReply = vi.fn(async (_text: string) => {});
    const onAssistantText = vi.fn<(payload: PartialReplyPayload) => Promise<void>>(
      async () => undefined,
    );
    const onReasoningProgress = vi.fn<(payload: ReasoningProgressPayload) => Promise<void>>(
      async () => undefined,
    );

    await runCliAgentWithLifecycle({
      runId: "run-activity-suppressed",
      suppressAssistantBridge: true,
      onActivity,
      onAssistantText,
      onCompletedReply,
      onReasoningProgress,
      runParams: {
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        prompt: "hello",
        provider: "claude-cli",
        model: "claude",
        thinkLevel: "high",
        timeoutMs: 1_000,
        runId: "run-activity-suppressed",
      },
    });

    // silentExpected runs suppress deliveries, but their events are still real
    // liveness evidence — without these stamps a healthy silent run would be
    // reclaimed as run_stalled at the takeover window.
    expect(onAssistantText).not.toHaveBeenCalled();
    expect(onCompletedReply).not.toHaveBeenCalled();
    expect(onReasoningProgress).not.toHaveBeenCalled();
    expect(onActivity).toHaveBeenCalledTimes(3);
  });

  it("stamps onActivity for assistant text without caller callbacks for that stream", async () => {
    cliDispatchState.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      emitAgentEvent({
        runId: params.runId,
        stream: "thinking",
        data: { text: "Deep thought", delta: "Deep thought", isReasoningSnapshot: true },
      });
      emitAgentEvent({
        runId: params.runId,
        stream: "assistant",
        data: { text: "Visible answer", delta: "Visible answer" },
      });
      return { payloads: [{ text: "Visible answer" }], meta: { durationMs: 1 } };
    });
    const onActivity = vi.fn();
    const onAssistantText = vi.fn<(payload: PartialReplyPayload) => Promise<void>>(
      async () => undefined,
    );
    const assistantEvents: Record<string, unknown>[] = [];
    const stop = onAgentEvent((event) => {
      if (event.runId === "run-activity-assistant" && event.stream === "assistant") {
        assistantEvents.push(event.data);
      }
    });

    try {
      await runCliAgentWithLifecycle({
        runId: "run-activity-assistant",
        onActivity,
        onAssistantText,
        runParams: createRunParams("run-activity-assistant"),
      });
    } finally {
      stop();
    }

    // Every real event stamps, independent of which callbacks are registered.
    expect(onAssistantText).toHaveBeenCalledTimes(1);
    expect(onActivity).toHaveBeenCalledTimes(2);
    expect(assistantEvents).toEqual([
      { text: "Visible answer", delta: "Visible answer" },
      { itemId: "cli-assistant:run-activity-assistant", text: "Visible answer" },
    ]);
  });

  it("retracts the current CLI preview while retaining earlier accepted replies", async () => {
    const runId = "run-silent-replacement";
    const earlier = "Earlier accepted answer.";
    const preview = "Considering whether another reply is needed.";
    const retry = "Here is the required answer.";
    cliDispatchState.runCliAgentMock.mockImplementationOnce(async () => {
      const handlers = createCliEventHandlers({
        context: buildContext(runId),
        toolTracking: buildToolTracking(),
        getRunState: () => ({ failed: false, error: undefined }),
      });
      handlers.emitCliCompletedReply(earlier, 0);
      handlers.emitCliThinkingDelta({ text: "Checking.", delta: "Checking." });
      handlers.emitCliAssistantDelta({ text: preview, delta: preview });
      handlers.emitCliCompletedReply(`${preview}\nNO_REPLY`, 1);
      handlers.emitCliAssistantDelta({ text: retry, delta: retry });
      handlers.emitCliCompletedReply(retry, 2);
      return { payloads: [], meta: { durationMs: 1 } } satisfies EmbeddedAgentRunResult;
    });
    const onAssistantText = vi.fn<(payload: PartialReplyPayload) => Promise<void>>(async () => {});
    const onCompletedReply = vi.fn(async (_text: string, _index: number) => {});
    const onReasoningText = vi.fn<(payload: ReasoningTextPayload) => Promise<void>>(async () => {});
    const wireReplacements: unknown[] = [];
    const stop = onAgentEvent((event) => {
      if (event.runId === runId && event.stream === "assistant" && event.data.replace === true) {
        wireReplacements.push(event.data.text);
      }
    });
    try {
      await runCliAgentWithLifecycle({
        runId,
        onAssistantText,
        onCompletedReply,
        onReasoningText,
        runParams: createRunParams(runId),
      });
    } finally {
      stop();
    }
    expect(onAssistantText.mock.calls.map(([payload]) => payload)).toEqual([
      { text: preview, delta: preview },
      { text: "", delta: "", replace: true },
      { text: retry, delta: retry },
    ]);
    expect(onCompletedReply.mock.calls).toEqual([
      [earlier, 0],
      [retry, 2],
    ]);
    expect(wireReplacements).toEqual([earlier]);
    expect(onReasoningText.mock.calls.map(([payload]) => payload)).toEqual([
      { text: "Checking." },
      { text: "", isReasoningSnapshot: true },
    ]);
  });

  it.each(["Stop hook", "tool commentary"])(
    "retracts a parser withdrawal after an accepted reply: %s",
    async (withdrawal) => {
      const runId = "run-parser-withdrawal";
      const earlier = "Earlier accepted answer.";
      const preview = "A provisional message that will be withdrawn.";
      const retry = "The revised answer.";
      cliDispatchState.runCliAgentMock.mockImplementationOnce(async () => {
        const handlers = createCliEventHandlers({
          context: buildContext(runId),
          toolTracking: buildToolTracking(),
          getRunState: () => ({ failed: false, error: undefined }),
        });
        const parser = createClaudeParser({
          onAssistantDelta: handlers.emitCliAssistantDelta,
          onCompletedReply: handlers.emitCliCompletedReply,
          ...(withdrawal === "tool commentary"
            ? { onCommentaryText: handlers.emitCliCommentaryText }
            : {}),
        });
        parser.push(
          joinJsonlFrames(
            claudeStreamEvent({ type: "message_start" }),
            claudeTextDelta(earlier),
            claudeStreamEvent({ type: "message_stop" }),
            { type: "result", result: earlier, openclaw_interim_result: true },
            claudeStreamEvent({ type: "message_start" }),
            claudeTextDelta(preview),
            withdrawal === "Stop hook"
              ? { type: "system", subtype: "notification", key: "stop-hook-error" }
              : claudeBlockStart({ type: "tool_use", id: "read-1", name: "Read" }),
            claudeStreamEvent({ type: "message_start" }),
            claudeTextDelta(retry),
            { type: "result", result: retry },
            "",
          ),
        );
        parser.finish();
        return { payloads: [], meta: { durationMs: 1 } } satisfies EmbeddedAgentRunResult;
      });
      const partials: PartialReplyPayload[] = [];
      const completed: string[] = [];
      const wireReplacements: unknown[] = [];
      const stop = onAgentEvent((event) => {
        if (event.runId === runId && event.stream === "assistant" && event.data.replace === true) {
          wireReplacements.push(event.data.text);
        }
      });
      try {
        await runCliAgentWithLifecycle({
          runId,
          runParams: createRunParams(runId),
          onAssistantText: async (payload) => {
            partials.push(payload);
          },
          onCompletedReply: async (text) => {
            completed.push(text);
          },
        });
      } finally {
        stop();
      }
      expect(partials.some(({ text }) => text?.includes(preview))).toBe(true);
      expect(partials.filter(({ replace }) => replace)).toEqual([
        { text: "", delta: "", replace: true },
      ]);
      expect(wireReplacements).toEqual([earlier]);
      expect(completed).toEqual([earlier]);
      expect(partials.at(-1)?.text).toContain(retry);
      expect(partials.at(-1)?.text).not.toContain(preview);
    },
  );

  it.each(["Last answer.", ""])(
    "uses the recorded visible CLI projection, including an empty one: %j",
    async (visibleText) => {
      const runId = "run-visible-projection";
      const assistantTexts: string[] = [];
      const stop = onAgentEvent((event) => {
        if (
          event.runId === runId &&
          event.stream === "assistant" &&
          typeof event.data.text === "string"
        ) {
          assistantTexts.push(event.data.text);
        }
      });
      cliDispatchState.runCliAgentMock.mockResolvedValueOnce({
        payloads: [
          { text: "This discussion is complete.\nNO_REPLY" },
          { text: visibleText || "NO_REPLY" },
        ],
        meta: { durationMs: 1, finalAssistantVisibleText: visibleText },
      } satisfies EmbeddedAgentRunResult);
      try {
        await runCliAgentWithLifecycle({ runId, runParams: createRunParams(runId) });
        expect(assistantTexts).toEqual(visibleText ? [visibleText] : []);
      } finally {
        stop();
      }
    },
  );

  it("keeps the captured lifecycle generation on the start event", async () => {
    const events: Array<{
      stream?: string;
      lifecycleGeneration?: string;
      agentId?: string;
      data?: Record<string, unknown>;
    }> = [];
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const stop = onAgentEvent((event) => {
      if (event.runId === "run-before-restart") {
        events.push(event);
      }
    });
    cliDispatchState.runCliAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);

    try {
      await runCliAgentWithLifecycle({
        runId: "run-before-restart",
        lifecycleGeneration,
        startedAt: 1_000,
        runParams: createRunParams("run-before-restart", {
          agentId: "support",
          thinkLevel: "off",
        }),
      });
    } finally {
      stop();
    }

    const lifecycleEvents = events.filter((event) => event.stream === "lifecycle");
    expect(lifecycleEvents).toHaveLength(1);
    expect(lifecycleEvents[0]?.data?.phase).toBe("start");
    expect(
      lifecycleEvents.every((event) => event.lifecycleGeneration === lifecycleGeneration),
    ).toBe(true);
    expect(lifecycleEvents.every((event) => event.agentId === "support")).toBe(true);
    expect(lifecycleEvents.every((event) => event.data?.startedAt === 1_000)).toBe(true);
  });

  it("preserves restart ownership when the CLI resolves after cancellation", async () => {
    const events: Array<{ stream?: string; data?: Record<string, unknown> }> = [];
    const stop = onAgentEvent((event) => {
      if (event.runId === "run-restart") {
        events.push(event);
      }
    });
    const controller = new AbortController();
    cliDispatchState.runCliAgentMock.mockImplementationOnce(async () => {
      controller.abort(createAgentRunRestartAbortError());
      return {
        payloads: [{ text: "stale result" }],
        meta: { durationMs: 1 },
      } satisfies EmbeddedAgentRunResult;
    });

    await expect(
      runCliAgentWithLifecycle({
        runId: "run-restart",
        runParams: createRunParams("run-restart", {
          thinkLevel: "off",
          abortSignal: controller.signal,
        }),
      }),
    ).rejects.toThrow("agent run aborted for restart");
    stop();

    expect(events.some((event) => event.stream === "assistant")).toBe(false);
  });
});

describe("keepCliSessionBindingOnlyWhenReused", () => {
  it("keeps the first room-event CLI binding when no binding exists yet", () => {
    const result = {
      payloads: [],
      meta: {
        durationMs: 1,
        agentMeta: {
          sessionId: "new-cli-session",
          provider: "claude-cli",
          model: "claude-opus-4-8",
          cliSessionBinding: {
            sessionId: "new-cli-session",
            authProfileId: "profile",
          },
        },
      },
    } satisfies EmbeddedAgentRunResult;

    expect(keepCliSessionBindingOnlyWhenReused({ result })).toBe(result);
  });

  it("drops a replacement room-event CLI binding when an existing binding was reused", () => {
    const onDroppedReplacement = vi.fn();
    const result = keepCliSessionBindingOnlyWhenReused({
      existingSessionId: "existing-cli-session",
      onDroppedReplacement,
      result: {
        payloads: [],
        meta: {
          durationMs: 1,
          agentMeta: {
            sessionId: "replacement-cli-session",
            provider: "claude-cli",
            model: "claude-opus-4-8",
            cliSessionBinding: {
              sessionId: "replacement-cli-session",
              authProfileId: "profile",
            },
          },
        },
      } satisfies EmbeddedAgentRunResult,
    });

    expect(onDroppedReplacement).toHaveBeenCalledOnce();
    expect(result.meta.agentMeta?.sessionId).toBe("");
    expect(result.meta.agentMeta?.cliSessionBinding).toBeUndefined();
  });
});

describe("clearCliSessionInStore", () => {
  it.each(["current", "closed"])(
    "clears active and stored entries only for a %s owner",
    async (owner) => {
      const activeEntry = {
        sessionId: "openclaw-active",
        updatedAt: 1,
        cliSessionBindings: { "claude-cli": { sessionId: "stale-session" } },
        cliSessionIds: { "claude-cli": "stale-session" },
        claudeCliSessionId: "stale-session",
      };
      const storedEntry = structuredClone(activeEntry);
      const storePath = path.join(tempDirs.make("cli-session-cleanup-"), "sessions.json");
      await replaceSessionEntry({ storePath, sessionKey: "main" }, structuredClone(activeEntry));

      let open = true;
      const clear = clearCliSessionInStore({
        agentId: "main",
        provider: "claude-cli",
        expectedCliSessionId: "stale-session",
        expectedSessionId: activeEntry.sessionId,
        sessionKey: "main",
        sessionStore: { main: storedEntry },
        storePath,
        activeSessionEntry: activeEntry,
        assertCommitAllowed: () => {
          if (!open) {
            throw new Error("owner closed");
          }
        },
      });
      if (owner === "closed") {
        open = false;
        await expect(clear).rejects.toThrow("owner closed");
        for (const entry of [
          activeEntry,
          storedEntry,
          loadSessionEntry({ storePath, sessionKey: "main" }),
        ]) {
          expect(entry?.cliSessionBindings?.["claude-cli"]?.sessionId).toBe("stale-session");
        }
        return;
      }
      await clear;

      for (const entry of [activeEntry, storedEntry]) {
        expect(entry.cliSessionBindings?.["claude-cli"]).toBeUndefined();
        expect(entry.cliSessionIds?.["claude-cli"]).toBeUndefined();
        expect(entry.claudeCliSessionId).toBeUndefined();
        expect(entry.updatedAt).toBeGreaterThan(1);
      }
      const persisted = loadSessionEntry({ storePath, sessionKey: "main" });
      expect(persisted?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
      expect(persisted?.cliSessionIds?.["claude-cli"]).toBeUndefined();
      expect(persisted?.claudeCliSessionId).toBeUndefined();
    },
  );

  it("does not clear a replacement binding adopted by another turn", async () => {
    const entry = {
      sessionId: "openclaw-active",
      updatedAt: 1,
      cliSessionBindings: { "claude-cli": { sessionId: "replacement-session" } },
      cliSessionIds: { "claude-cli": "replacement-session" },
      claudeCliSessionId: "replacement-session",
    };

    await clearCliSessionInStore({
      agentId: "main",
      provider: "claude-cli",
      expectedCliSessionId: "stale-session",
      activeSessionEntry: entry,
    });

    expect(entry.cliSessionBindings["claude-cli"].sessionId).toBe("replacement-session");
    expect(entry.cliSessionIds["claude-cli"]).toBe("replacement-session");
    expect(entry.claudeCliSessionId).toBe("replacement-session");
    expect(entry.updatedAt).toBe(1);
  });
});

describe("createCliToolSummaryTracker", () => {
  const startEvent = {
    name: "exec",
    phase: "start" as const,
    args: { command: "date -u" },
    toolCallId: "tool-1",
  };
  const resultEvent = {
    name: "exec",
    phase: "result" as const,
    args: undefined,
    toolCallId: "tool-1",
    isError: false,
    result: { content: [{ type: "text", text: "Wed Jun 10 2026" }] },
  };

  it.each(["exec"])("delivers a safe %s summary using metadata captured at start", async (name) => {
    const deliver = vi.fn();
    const tracker = createCliToolSummaryTracker({
      commandDetailsVisible: false,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      deliver,
    });
    await tracker.noteToolEvent({ ...startEvent, name });
    const commandBearing = await tracker.noteToolEvent({ ...resultEvent, name });
    expect(commandBearing).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);
    const payload = deliver.mock.calls[0]?.[0] as { text: string; isError?: boolean };
    expect(payload.text).toBe(name === "server.exec" ? "Server.exec" : "Exec");
    expect(payload.text).not.toContain("date -u");
    expect(payload.text).not.toContain("Wed Jun 10 2026");
    expect(payload.isError).toBeUndefined();
  });

  it("renders top-level structured CLI results in full verbose output", async () => {
    const deliver = vi.fn();
    const tracker = createCliToolSummaryTracker({
      commandDetailsVisible: true,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => true,
      deliver,
    });
    await tracker.noteToolEvent(startEvent);
    await tracker.noteToolEvent({
      ...resultEvent,
      result: [{ type: "web_search_result", title: "OpenClaw", url: "https://example.com" }],
    });

    const payload = deliver.mock.calls[0]?.[0] as { text: string };
    expect(payload.text).toContain('"type":"web_search_result"');
    expect(payload.text).toContain('"title":"OpenClaw"');
  });

  it("emits nothing while tool summaries are disabled", async () => {
    const deliver = vi.fn();
    const tracker = createCliToolSummaryTracker({
      commandDetailsVisible: false,
      shouldEmitToolResult: () => false,
      shouldEmitToolOutput: () => false,
      deliver,
    });
    await tracker.noteToolEvent(startEvent);
    await tracker.noteToolEvent(resultEvent);
    expect(deliver).not.toHaveBeenCalled();
  });

  it.each(["update_plan"])(
    "leaves %s to the authoritative plan event instead of summarizing arguments",
    async (name) => {
      const deliver = vi.fn();
      const tracker = createCliToolSummaryTracker({
        commandDetailsVisible: true,
        shouldEmitToolResult: () => true,
        shouldEmitToolOutput: () => true,
        deliver,
      });
      await tracker.noteToolEvent({
        name,
        phase: "start",
        args: {
          markdown: '<progress aria-label="CI · 2/3" value="2" max="3"></progress>',
        },
        toolCallId: "plan-1",
      });
      await tracker.noteToolEvent({
        name,
        phase: "result",
        args: undefined,
        toolCallId: "plan-1",
        isError: false,
        result: { content: [{ type: "text", text: "Progress card updated" }] },
      });

      expect(deliver).not.toHaveBeenCalled();
    },
  );

  it.each([true])(
    "keeps card errors visible without arguments (full output: %s)",
    async (fullOutput) => {
      const deliver = vi.fn();
      const tracker = createCliToolSummaryTracker({
        commandDetailsVisible: false,
        shouldEmitToolResult: () => true,
        shouldEmitToolOutput: () => fullOutput,
        deliver,
      });
      await tracker.noteToolEvent({
        name: "progress_card",
        phase: "start",
        args: { markdown: '<progress aria-label="private" value="1" max="2"></progress>' },
        toolCallId: "plan-error",
      });
      await tracker.noteToolEvent({
        name: undefined,
        phase: "result",
        args: undefined,
        toolCallId: "plan-error",
        isError: true,
        result: { content: [{ type: "text", text: "write failed" }] },
      });

      expect(deliver).toHaveBeenCalledWith({
        text: fullOutput ? "Progress Card\n```txt\nwrite failed\n```" : "Progress Card",
        isError: true,
      });
    },
  );
});

describe("runCliAgentWithLifecycle fast auto progress", () => {
  it("emits auto-off after the first CLI tool boundary past the threshold", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const events: Array<{ stream: string; data: Record<string, unknown> }> = [];
    const stop = onAgentEvent((evt) => {
      if (evt.runId === "run-fast-cli") {
        events.push({ stream: evt.stream, data: evt.data });
      }
    });
    const progressPayloads: string[] = [];
    cliDispatchState.runCliAgentMock.mockImplementation(async () => {
      emitAgentEvent({
        runId: "run-fast-cli",
        stream: "tool",
        data: { phase: "start", name: "bash", toolCallId: "call-1" },
      });
      vi.setSystemTime(7_100);
      emitAgentEvent({
        runId: "run-fast-cli",
        stream: "tool",
        data: { phase: "result", name: "bash", toolCallId: "call-1" },
      });
      return {
        payloads: [{ text: "done" }],
        meta: {
          durationMs: 7_100,
          agentMeta: { sessionId: "session-1", provider: "codex-cli", model: "gpt-5.5" },
        },
      } satisfies EmbeddedAgentRunResult;
    });

    await runCliAgentWithLifecycle({
      runId: "run-fast-cli",
      runParams: createRunParams("run-fast-cli", {
        sessionKey: "agent:main:cli-fast",
        prompt: "run one tool",
        provider: "codex-cli",
        model: "gpt-5.5",
        thinkLevel: undefined,
        timeoutMs: 60_000,
        fastMode: "auto",
        fastModeStartedAtMs: 1_000,
        fastModeAutoOnSeconds: 5,
      }),
      onFastModeAutoProgress: async (payload) => {
        if (payload.text) {
          progressPayloads.push(payload.text);
        }
      },
    });
    stop();

    const summaries = events
      .filter((event) => event.stream === "item")
      .map((event) => event.data.summary);
    expect(summaries).toContain("💨Fast: auto-off(6s>=5s)");
    expect(summaries).toContain("💨Fast: auto-on");
    expect(progressPayloads).toEqual(["💨Fast: auto-off(6s>=5s)", "💨Fast: auto-on"]);
  });
});
