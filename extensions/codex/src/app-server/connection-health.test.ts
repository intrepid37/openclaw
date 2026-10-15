import type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { createCodexAppServerConnectionHealthService } from "./connection-health.js";
import { createClientHarness } from "./test-support.js";

const sharedClientMocks = vi.hoisted(() => ({
  getSharedCodexAppServerClient: vi.fn(),
}));

vi.mock("./shared-client.js", () => sharedClientMocks);

let runningService:
  | { service: OpenClawPluginService; ctx: OpenClawPluginServiceContext }
  | undefined;

describe("Codex remote WebSocket connection health", () => {
  beforeAll(async () => {
    // Complete lazy-module fixture preparation before measuring connection and retry behavior.
    await Promise.all([import("./config-runtime.js"), import("./client.js")]);
  });

  afterEach(async () => {
    try {
      if (runningService) {
        await runningService.service.stop?.(runningService.ctx);
      }
    } finally {
      runningService = undefined;
      sharedClientMocks.getSharedCodexAppServerClient.mockReset();
      vi.useRealTimers();
    }
  });

  it("reconnects after the shared remote app-server connection closes", async () => {
    const first = createClient();
    const second = createClient();
    sharedClientMocks.getSharedCodexAppServerClient
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);
    const { ctx, service } = createService();

    await startService(service, ctx);
    await vi.waitFor(() => expect(first.addCloseHandler).toHaveBeenCalledOnce());

    first.close();

    await vi.waitFor(
      () => {
        expect(sharedClientMocks.getSharedCodexAppServerClient).toHaveBeenCalledTimes(2);
        expect(second.addCloseHandler).toHaveBeenCalledOnce();
      },
      { timeout: 3_000 },
    );
    expect(first.request).not.toHaveBeenCalled();
    expect(second.request).not.toHaveBeenCalled();

    await service.stop?.(ctx);
  });

  it("retries a transient remote connection failure without starting a model", async () => {
    const client = createClient();
    sharedClientMocks.getSharedCodexAppServerClient
      .mockRejectedValueOnce(new Error("Opening handshake has timed out"))
      .mockResolvedValueOnce(client.client);
    const { ctx, service } = createService();

    await startService(service, ctx);

    await vi.waitFor(
      () => {
        expect(sharedClientMocks.getSharedCodexAppServerClient).toHaveBeenCalledTimes(2);
        expect(client.addCloseHandler).toHaveBeenCalledOnce();
      },
      { timeout: 3_000 },
    );
    expect(client.request).not.toHaveBeenCalled();

    await service.stop?.(ctx);
  });

  it("reconnects when a shared client closed before the health observer subscribed", async () => {
    vi.useFakeTimers();
    const first = createClientHarness();
    first.client.close();
    const next = createClient();
    sharedClientMocks.getSharedCodexAppServerClient
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(next.client);
    const { ctx, service } = createService();

    await startService(service, ctx);
    await vi.advanceTimersByTimeAsync(1_250);

    expect(sharedClientMocks.getSharedCodexAppServerClient).toHaveBeenCalledTimes(2);
    expect(next.addCloseHandler).toHaveBeenCalledOnce();
    expect(first.writes).toEqual([]);
    expect(next.request).not.toHaveBeenCalled();
  });

  it.each([401, 403])("does not retry an HTTP %i authentication failure", async (statusCode) => {
    sharedClientMocks.getSharedCodexAppServerClient.mockRejectedValueOnce(
      new Error(`Unexpected server response: ${statusCode}`),
    );
    const { ctx, service } = createService();

    await startService(service, ctx);

    await vi.waitFor(() => {
      expect(ctx.logger.error).toHaveBeenCalledWith(
        expect.stringContaining(`Unexpected server response: ${statusCode}`),
      );
    });
    expect(sharedClientMocks.getSharedCodexAppServerClient).toHaveBeenCalledOnce();

    await service.stop?.(ctx);
  });

  it("does not retry an invalid remote app-server configuration", async () => {
    const { ctx, service } = createService({ appServer: { transport: "websocket" } });

    await startService(service, ctx);

    await vi.waitFor(() => {
      expect(ctx.logger.error).toHaveBeenCalledWith(
        expect.stringContaining("configuration is invalid"),
      );
    });
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();

    await service.stop?.(ctx);
  });

  it("does not connect or start a model for local transports", async () => {
    const { ctx, service } = createService({ appServer: { transport: "stdio" } });

    await startService(service, ctx);
    await service.stop?.(ctx);

    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });
});

function startService(service: OpenClawPluginService, ctx: OpenClawPluginServiceContext) {
  runningService = { service, ctx };
  return service.start(ctx);
}

function createClient() {
  const handlers = new Set<(client: CodexAppServerClient) => void>();
  const request = vi.fn();
  const addCloseHandler = vi.fn((handler: (client: CodexAppServerClient) => void) => {
    handlers.add(handler);
    return () => handlers.delete(handler);
  });
  const client = {
    addCloseHandler,
    request,
    getCloseError: () => undefined,
  } as unknown as CodexAppServerClient;

  return {
    client,
    request,
    addCloseHandler,
    close() {
      for (const handler of handlers) {
        handler(client);
      }
    },
  };
}

function createService(
  pluginConfig: unknown = {
    appServer: { transport: "websocket", url: "ws://127.0.0.1:39175" },
  },
) {
  const ctx: OpenClawPluginServiceContext = {
    config: {},
    stateDir: "/tmp/openclaw-codex-connection-health-test",
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
  return {
    ctx,
    service: createCodexAppServerConnectionHealthService({
      getPluginConfig: () => pluginConfig,
      getRuntimeConfig: () => ctx.config,
    }),
  };
}
