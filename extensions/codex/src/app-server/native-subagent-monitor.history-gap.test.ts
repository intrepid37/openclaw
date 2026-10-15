import { expect, it, vi } from "vitest";
import {
  CodexNativeSubagentMonitor,
  createClient,
  createRuntime,
  notifyChildStarted,
  registerParent,
  threadRead,
  turnStartedNotification,
} from "./native-subagent-monitor.test-support.js";

function pagedTurn(result: string, turnId = "child-turn", status = "completed") {
  return {
    data: [
      {
        id: turnId,
        status,
        items: [{ id: "message-1", type: "agentMessage", text: result, phase: "final_answer" }],
        error: null,
        completedAt: 1_779_063_288,
      },
    ],
    nextCursor: null,
    backwardsCursor: null,
  };
}

function createHistoryGapFixture() {
  const client = createClient();
  const runtime = createRuntime();
  const releaseClient = vi.fn();
  const monitor = new CodexNativeSubagentMonitor(client.client, runtime, {
    retainClient: () => releaseClient,
  });
  const metadata = threadRead({ threadStatus: "idle" });
  metadata.thread.turns = [];
  client.setThreadReadFactory("child-thread", ({ includeTurns }) => {
    if (includeTurns) {
      throw new Error(
        "thread child-thread is not materialized yet; includeTurns is unavailable before first user message",
      );
    }
    return metadata;
  });
  return {
    client,
    runtime,
    releaseClient,
    monitor,
    metadata,
    register: async () => {
      const owner = await registerParent(monitor);
      await notifyChildStarted(client);
      await client.notify(turnStartedNotification("child-turn"));
      await owner.unregister();
    },
  };
}

it.each(["persisted final", "NO_REPLY"])(
  "recovers an idle child's matching paged completion %s and releases its client once",
  async (result) => {
    vi.useFakeTimers();
    const { client, runtime, releaseClient, monitor, register } = createHistoryGapFixture();
    client.setThreadTurns("child-thread", pagedTurn(result));
    try {
      await register();
      // Use production backoff: the child must settle without a live-history
      // repair, a completion notification, or a synthetic terminal failure.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledWith(
        expect.objectContaining({ status: "succeeded", result }),
      );
      expect(releaseClient).toHaveBeenCalledOnce();

      await monitor.reconcileChildThread("child-thread");
      await vi.advanceTimersByTimeAsync(600_000);
      expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledOnce();
      expect(releaseClient).toHaveBeenCalledOnce();
    } finally {
      client.close();
      await monitor.dispose();
      vi.useRealTimers();
    }
  },
);

it.each(["active", "inProgress", "other-turn", "unavailable"] as const)(
  "does not settle a history gap from %s evidence",
  async (condition) => {
    vi.useFakeTimers();
    const { client, runtime, releaseClient, monitor, metadata, register } =
      createHistoryGapFixture();
    const completed = pagedTurn("matching final");
    const paged = pagedTurn(
      "must not deliver",
      condition === "other-turn" ? "other-turn" : "child-turn",
      condition === "inProgress" ? "inProgress" : "completed",
    );
    if (condition === "active") {
      metadata.thread.status = { type: "active" };
    }
    client.setThreadTurns(
      "child-thread",
      condition === "unavailable" ? new Error("history temporarily unavailable") : paged,
    );
    try {
      await register();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
      expect(releaseClient).not.toHaveBeenCalled();

      metadata.thread.status = { type: "idle" };
      client.setThreadTurns("child-thread", completed);
      await monitor.reconcileChildThread("child-thread");
      expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledWith(
        expect.objectContaining({ status: "succeeded", result: "matching final" }),
      );
      expect(releaseClient).toHaveBeenCalledOnce();
    } finally {
      client.close();
      await monitor.dispose();
      vi.useRealTimers();
    }
  },
);
