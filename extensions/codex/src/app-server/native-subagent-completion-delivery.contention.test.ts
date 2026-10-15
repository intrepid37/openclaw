import assert from "node:assert/strict";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { CodexNativeSubagentCompletionDelivery } from "./native-subagent-completion-delivery.js";
import { fixture } from "./native-subagent-inventory.test-support.js";
import {
  CodexNativeSubagentMonitor,
  childTurnCompletedNotification,
  createClient,
  createRuntime,
  nativeCompletionNotification,
  notifyChildStarted,
  registerParent,
} from "./native-subagent-monitor.test-support.js";
import { setupRunAttemptTestHooks } from "./run-attempt-test-harness.js";

const result = "Keep the accepted native result.";
const completedChild = () =>
  childTurnCompletedNotification({
    status: "completed",
    items: [{ type: "agentMessage", id: "final", phase: "final_answer", text: result }],
  });

describe("native completion durable receipts", () => {
  setupRunAttemptTestHooks();
  it("keeps a durable delivery receipt when its next ownership read fails", async () => {
    const f = await fixture();
    const client = createClient();
    const read = f.store.read.bind(f.store);
    let failNextRead = false;
    let failedReads = 0;
    vi.spyOn(f.store, "read").mockImplementation((identity) => {
      if (failNextRead) {
        failNextRead = false;
        failedReads += 1;
        throw new Error("ownership read unavailable after delivery");
      }
      return read(identity);
    });
    const mutate = f.store.mutate.bind(f.store);
    const writes: Promise<boolean>[] = [];
    const mutations = vi.spyOn(f.store, "mutate").mockImplementation((...args) => {
      const write = mutate(...args);
      writes.push(write);
      return write;
    });
    f.deliver.mockImplementation(async ({ completionCustody }) => {
      assert(completionCustody?.isCurrent());
      failNextRead = true;
      return { delivered: true, path: "direct" };
    });
    const parent = await f.register(client);
    try {
      await parent.ready;
      parent.bindTurn("parent-turn");
      await f.spawn(client);
      await parent.unregister();
      await client.notify(completedChild());
      expect(failedReads).toBe(1);
      expect(f.deliver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ result }));
      expect(
        mutations.mock.calls.filter(
          ([, mutation]) => mutation.kind === "consume-native-subagent-assignment",
        ),
      ).toHaveLength(1);
      await Promise.all(writes);
      expect(f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner())).toEqual([]);
      client.close();
      const replacement = await f.register(createClient());
      await replacement.ready;
      await replacement.unregister();
      expect(f.deliver).toHaveBeenCalledOnce();
    } finally {
      failNextRead = false;
      await parent.unregister();
      client.close();
      await Promise.allSettled(writes);
    }
  });
});

describe("native completion settlement", () => {
  it("releases the last terminal child's transport before its queued handoff and survives synchronous close", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const entered = createDeferred<void>();
    const secondQueued = createDeferred<void>();
    const transportReleased = createDeferred<void>();
    const finishFirst = createDeferred<void>();
    const releaseClient = vi.fn(() => {
      client.close();
      transportReleased.resolve();
    });
    runtime.deliverAgentHarnessCompletion.mockImplementationOnce(async () => {
      entered.resolve();
      await transportReleased.promise;
      await finishFirst.promise;
      return { delivered: true, path: "direct" };
    });
    const prototype = CodexNativeSubagentCompletionDelivery.prototype;
    const observe = vi.spyOn(prototype, "deliverPending");
    prototype.deliverPending = function (
      this: CodexNativeSubagentCompletionDelivery,
      state,
      child,
    ) {
      const attempt = observe.call(this, state, child);
      if (child.childThreadId === "second-child") {
        secondQueued.resolve();
      }
      return attempt;
    };
    const monitor = new CodexNativeSubagentMonitor(client.client, runtime, {
      retainClient: () => releaseClient,
      recoveryPollDelaysMs: [],
    });
    const parent = await registerParent(monitor);
    const pending: Promise<void>[] = [];
    const complete = (threadId: string) =>
      client.notify(
        childTurnCompletedNotification({
          threadId,
          status: "completed",
          items: [{ type: "agentMessage", id: "final", phase: "final_answer", text: threadId }],
        }),
      );
    try {
      parent.bindTurn("parent-turn");
      await notifyChildStarted(client, "parent-thread", "first-child");
      await notifyChildStarted(client, "parent-thread", "second-child");
      await parent.unregister();
      pending.push(complete("first-child"));
      await entered.promise;
      expect(releaseClient).not.toHaveBeenCalled();
      pending.push(complete("second-child"));
      await secondQueued.promise;
      expect(releaseClient).toHaveBeenCalledOnce();
      expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledOnce();
      finishFirst.resolve();
      await Promise.all(pending);
      expect(
        runtime.deliverAgentHarnessCompletion.mock.calls.map(([input]) => input.childSessionId),
      ).toEqual(["first-child", "second-child"]);
      expect(releaseClient).toHaveBeenCalledOnce();
    } finally {
      transportReleased.resolve();
      finishFirst.resolve();
      await Promise.allSettled(pending);
      observe.mockRestore();
      await parent.unregister();
      await monitor.dispose();
      client.close();
    }
  });

  it.each(["deliver", "foreground receipt", "retirement"] as const)(
    "serializes sibling requester handoffs and rechecks %s after waiting",
    async (outcome) => {
      const client = createClient();
      const runtime = createRuntime();
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      runtime.deliverAgentHarnessCompletion.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return { delivered: true, path: "direct" };
      });
      const monitor = new CodexNativeSubagentMonitor(client.client, runtime, {
        recoveryPollDelaysMs: [],
      });
      const parent = await registerParent(monitor);
      const other = await registerParent(monitor, "other-parent", "agent:main:other");
      let foreground: Awaited<ReturnType<typeof registerParent>> | undefined;
      const pending: Promise<void>[] = [];
      const complete = (threadId: string) =>
        client.notify(
          childTurnCompletedNotification({
            threadId,
            status: "completed",
            items: [{ type: "agentMessage", id: "final", phase: "final_answer", text: threadId }],
          }),
        );
      try {
        parent.bindTurn("parent-turn");
        other.bindTurn("other-turn");
        await notifyChildStarted(client, "parent-thread", "first-child");
        await notifyChildStarted(client, "parent-thread", "second-child");
        await notifyChildStarted(client, "other-parent", "other-child");
        await parent.unregister();
        await other.unregister();
        pending.push(complete("first-child"));
        await entered.promise;
        pending.push(complete("second-child"));
        // An unrelated requester must finish while the first response is still held.
        await complete("other-child");
        expect(
          runtime.deliverAgentHarnessCompletion.mock.calls.map(([input]) => input.result),
        ).toEqual(["first-child", "other-child"]);

        if (outcome === "foreground receipt") {
          foreground = await registerParent(monitor);
          foreground.bindTurn("foreground-turn");
          // A resumed parent may spawn/wait for another child while its detached
          // handoff is still running. Its native completion cannot wait on this lane.
          await notifyChildStarted(client, "parent-thread", "foreground-child");
          await complete("foreground-child");
          for (const child of ["foreground-child", "second-child"]) {
            await client.notify(
              nativeCompletionNotification({
                turnId: "foreground-turn",
                agentPath: child,
                result: child,
              }),
            );
          }
          await foreground.unregister();
        } else if (outcome === "retirement") {
          pending.push(monitor.retireParent("parent-thread"));
        }
        release.resolve();
        await Promise.all(pending);
        expect(
          runtime.deliverAgentHarnessCompletion.mock.calls.map(([input]) => input.result),
        ).toEqual(
          outcome === "deliver"
            ? ["first-child", "other-child", "second-child"]
            : ["first-child", "other-child"],
        );
      } finally {
        release.resolve();
        await Promise.allSettled(pending);
        await foreground?.unregister();
        await parent.unregister();
        await other.unregister();
        await monitor.dispose();
        client.close();
      }
    },
  );

  it.each(["receipt", "retired-turn-receipt", "retirement"] as const)(
    "rechecks %s while completion delivery is in flight",
    async (change) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const client = createClient();
      const runtime = createRuntime();
      const entered = createDeferred<void>();
      const delivery = createDeferred<{ delivered: false; path: "none" }>();
      runtime.deliverAgentHarnessCompletion.mockImplementationOnce(async () => {
        entered.resolve();
        return await delivery.promise;
      });
      const releasePin = vi.fn();
      const monitor = new CodexNativeSubagentMonitor(client.client, runtime, {
        recoveryPollDelaysMs: [],
        completionDeliveryRetryDelaysMs: [10],
        retainParentThread: () => releasePin,
      });
      const parent = await registerParent(monitor);
      let observer: Awaited<ReturnType<typeof registerParent>> | undefined;
      let completion: Promise<void> | undefined;
      let retirement: Promise<void> | undefined;
      try {
        parent.bindTurn("parent-turn");
        await notifyChildStarted(client);
        await parent.unregister();
        completion = client.notify(completedChild());
        await entered.promise;
        expect(releasePin).not.toHaveBeenCalled();
        const canAdmit =
          runtime.deliverAgentHarnessCompletion.mock.calls[0]?.[0].isSourceSessionAdmissionAllowed;
        expect(canAdmit?.()).toBe(true);
        if (change === "retirement") {
          retirement = monitor.retireParent("parent-thread");
          expect(canAdmit?.()).toBe(false);
        } else {
          observer = await registerParent(monitor);
          observer.bindTurn("observer-turn");
          await client.notify(
            nativeCompletionNotification({
              turnId: change === "receipt" ? "observer-turn" : "parent-turn",
              result,
            }),
          );
          // A receipt cannot release custody still owned by the accepted delivery.
          expect(releasePin).not.toHaveBeenCalled();
        }
        delivery.resolve({ delivered: false, path: "none" });
        await completion;
        await retirement;
        expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledOnce();
        if (change === "retired-turn-receipt") {
          expect(releasePin).not.toHaveBeenCalled();
          expect(vi.getTimerCount()).toBe(1);
          await observer?.unregister();
          await vi.advanceTimersByTimeAsync(10);
          expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledTimes(2);
        }
        expect(releasePin).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        delivery.resolve({ delivered: false, path: "none" });
        await completion;
        await monitor.retireParent("parent-thread");
        await observer?.unregister();
        await parent.unregister();
        await monitor.dispose();
        client.close();
        vi.useRealTimers();
      }
    },
  );
});
