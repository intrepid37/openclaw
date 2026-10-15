import type { ProviderAppGuidedSetupContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createQueuedWizardPrompter,
  createNonExitingRuntimeEnv,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type {
  ProviderAuthContext,
  ProviderAuthMethodNonInteractiveContext,
  ProviderCatalogContext,
} from "openclaw/plugin-sdk/provider-setup";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureOmlxInteractive,
  configureOmlxNonInteractive,
  detectOmlx,
  detectOmlxAvailability,
  discoverOmlxProvider,
  prepareOmlx,
  validateOmlxNonInteractive,
} from "./setup.js";

const modelId = "mlx-community/Qwen3-4B-Instruct-4bit";
const rows = [
  { id: "text-embedding-mini", max_model_len: 512 },
  { id: modelId, max_model_len: 32_768 },
  { id: "custom-chat", max_model_len: 8_192 },
];

function fixture(data: unknown = rows, status = 200) {
  const fetchMock = vi.fn(async () => Response.json({ data }, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function guidedContext(): ProviderAppGuidedSetupContext {
  return { config: {}, env: {} };
}

function catalogContext(): ProviderCatalogContext {
  return {
    ...guidedContext(),
    providerIds: ["omlx"],
    resolveProviderApiKey: () => ({ apiKey: undefined }),
    resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
  };
}

function interactiveContext(key = ""): ProviderAuthContext {
  const { prompter } = createQueuedWizardPrompter({
    textValues: ["http://127.0.0.1:8000/v1/", key],
    selectValues: [modelId],
  });
  return {
    ...guidedContext(),
    prompter,
    runtime: createNonExitingRuntimeEnv(),
    secretInputMode: "plaintext",
    allowSecretRefPrompt: false,
    isRemote: false,
    openUrl: async () => {},
    oauth: {
      createVpsAwareHandlers: () => {
        throw new Error("unused");
      },
    },
  };
}

function nonInteractiveContext(): ProviderAuthMethodNonInteractiveContext {
  return {
    authChoice: "omlx",
    config: {},
    baseConfig: {},
    opts: { customModelId: modelId },
    runtime: createNonExitingRuntimeEnv(),
    resolveApiKey: vi.fn(async () => null),
    toApiKeyCredential: vi.fn(() => {
      throw new Error("keyless setup must not store credentials");
    }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("oMLX setup through the inference catalog", () => {
  it("discovers chat models and prepares a keyless model with server context", async () => {
    const fetchMock = fixture();
    const ctx = guidedContext();
    await expect(detectOmlxAvailability(ctx)).resolves.toBe(true);
    await expect(detectOmlx(ctx)).resolves.toEqual({
      modelRef: `omlx/${modelId}`,
      detail: modelId,
    });
    const prepared = await prepareOmlx({ ...ctx, modelRef: `omlx/${modelId}` });
    expect(prepared).toMatchObject({
      profiles: [],
      defaultModel: `omlx/${modelId}`,
      configPatch: {
        models: {
          providers: {
            omlx: {
              api: "openai-completions",
              apiKey: "omlx-local",
              baseUrl: "http://127.0.0.1:8000/v1",
              models: [
                { id: "custom-chat", contextWindow: 8_192 },
                { id: modelId, contextWindow: 32_768 },
              ],
            },
          },
        },
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/v1/models",
      expect.objectContaining({
        headers: {},
      }),
    );
    await expect(prepareOmlx({ ...ctx, modelRef: "omlx/custom-chat" })).resolves.toBeNull();
    await expect(prepareOmlx({ ...ctx, modelRef: "omlx/missing" })).resolves.toBeNull();
  });

  it.each([[{ id: "unknown-context" }], [{ id: "text-embedding-mini", max_model_len: 32_768 }]])(
    "does not auto-select unqualified model rows %j",
    async (data) => {
      fixture(data);
      await expect(detectOmlxAvailability(guidedContext())).resolves.toBe(true);
      await expect(detectOmlx(guidedContext())).resolves.toBeNull();
    },
  );

  it.each([401, 503])("does not produce configuration after HTTP %s", async (status) => {
    fixture(rows, status);
    await expect(detectOmlxAvailability(guidedContext())).resolves.toBe(false);
    await expect(
      prepareOmlx({ ...guidedContext(), modelRef: `omlx/${modelId}` }),
    ).resolves.toBeNull();
    await expect(configureOmlxInteractive(interactiveContext())).rejects.toThrow("Start oMLX");
  });

  it("handles an unreachable server and propagates cancellation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(detectOmlxAvailability(guidedContext())).resolves.toBe(false);
    await expect(detectOmlx({ ...guidedContext(), signal: AbortSignal.abort() })).rejects.toThrow();
  });

  it("honors configured headers and private-network policy", async () => {
    const fetchMock = fixture();
    const ctx = guidedContext();
    ctx.config = {
      models: {
        providers: {
          omlx: {
            baseUrl: "http://127.0.0.1:8000/v1",
            models: [],
            apiKey: "omlx-local",
            headers: { Authorization: "Bearer fixture-header" },
            request: {
              allowPrivateNetwork: true,
              headers: { "X-Fixture": "catalog", authorization: "Bearer overridden-header" },
            },
          },
        },
      },
    };
    await expect(detectOmlxAvailability(ctx)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { authorization: "Bearer overridden-header", "X-Fixture": "catalog" },
      }),
    );
    const provider = ctx.config.models?.providers?.omlx;
    if (!provider) {
      throw new Error("missing fixture provider");
    }
    provider.request = { allowPrivateNetwork: false };
    fetchMock.mockClear();
    await expect(detectOmlxAvailability(ctx)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      auth: { mode: "authorization-bearer" as const, token: "${OMLX_TEST_TOKEN}" },
      expectedHeaders: { Authorization: "Bearer fixture-auth-override" },
    },
    {
      auth: { mode: "header" as const, headerName: "X-Local-Key", value: "${OMLX_TEST_TOKEN}" },
      expectedHeaders: { "X-Local-Key": "fixture-auth-override" },
    },
  ])(
    "uses request.auth $auth.mode without forwarding stale authorization",
    async ({ auth, expectedHeaders }) => {
      const fetchMock = fixture();
      const ctx = guidedContext();
      ctx.env = { OMLX_TEST_TOKEN: "fixture-auth-override" };
      ctx.config = {
        models: {
          providers: {
            omlx: {
              baseUrl: "http://127.0.0.1:8000/v1",
              apiKey: "stale-provider-key",
              headers: { authorization: "Bearer stale-header" },
              request: { auth },
              models: [],
            },
          },
        },
      };
      await expect(detectOmlxAvailability(ctx)).resolves.toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ headers: expectedHeaders }),
      );
    },
  );

  it("makes catalog discovery opt-in and exposes only chat rows", async () => {
    const fetchMock = fixture();
    const ctx = catalogContext();
    await expect(discoverOmlxProvider({ ...ctx, providerIds: undefined })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(discoverOmlxProvider(ctx)).resolves.toMatchObject({
      provider: {
        models: [{ id: "custom-chat" }, { id: modelId }],
      },
    });
  });

  it.each([401, 503])("reports HTTP %s catalog failures rather than skipping", async (status) => {
    fixture(rows, status);
    await expect(discoverOmlxProvider(catalogContext())).resolves.toMatchObject({
      providers: {},
      outcomes: [{ provider: "omlx", status: status === 401 ? "auth-rejected" : "unavailable" }],
    });
  });

  it.each(["", "fixture-key"])("configures interactive setup with optional key %j", async (key) => {
    const fetchMock = fixture();
    const result = await configureOmlxInteractive(interactiveContext(key));
    expect(result.defaultModel).toBe(`omlx/${modelId}`);
    expect(result.configPatch?.models?.providers?.omlx?.apiKey).toBe(
      key ? "OMLX_API_KEY" : "omlx-local",
    );
    expect(result.profiles).toEqual(
      key
        ? [
            {
              profileId: "omlx:default",
              credential: { type: "api_key", provider: "omlx", key },
            },
          ]
        : [],
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: key ? { Authorization: `Bearer ${key}` } : {},
      }),
    );
  });

  it("does not forward saved credentials or headers when setup changes the endpoint", async () => {
    const fetchMock = fixture();
    const ctx = interactiveContext();
    ctx.config = {
      models: {
        providers: {
          omlx: {
            baseUrl: "http://127.0.0.1:9000/v1",
            apiKey: "old-endpoint-key",
            headers: { Authorization: "Bearer old-header-key" },
            request: { headers: { "X-Api-Key": "old-custom-key" } },
            models: [],
          },
        },
      },
    };
    const result = await configureOmlxInteractive(ctx);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/v1/models",
      expect.objectContaining({ headers: {} }),
    );
    const provider = result.configPatch?.models?.providers?.omlx;
    expect(provider?.headers).toBeUndefined();
    expect(provider?.request).toBeUndefined();
    expect(provider?.apiKey).toBe("omlx-local");
  });

  it("validates noninteractive models before persistence", async () => {
    fixture();
    const ctx = nonInteractiveContext();
    ctx.opts.customModelId = "missing";
    await expect(validateOmlxNonInteractive(ctx)).resolves.toBe(false);
    await expect(configureOmlxNonInteractive(ctx)).resolves.toBeNull();
    expect(ctx.toApiKeyCredential).not.toHaveBeenCalled();
  });

  it("retains a private-network denial when setup changes the endpoint", async () => {
    const fetchMock = fixture();
    const ctx = interactiveContext();
    ctx.config = {
      models: {
        providers: {
          omlx: {
            baseUrl: "https://models.example.test/v1",
            models: [],
            request: { allowPrivateNetwork: false },
          },
        },
      },
    };
    await expect(configureOmlxInteractive(ctx)).rejects.toThrow("Start oMLX");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("configures keyless noninteractive setup without creating a credential", async () => {
    fixture();
    const ctx = nonInteractiveContext();
    await expect(configureOmlxNonInteractive(ctx)).resolves.toMatchObject({
      models: {
        providers: {
          omlx: { apiKey: "omlx-local", models: [{ id: "custom-chat" }, { id: modelId }] },
        },
      },
      agents: { defaults: { model: { primary: `omlx/${modelId}` } } },
    });
    expect(ctx.toApiKeyCredential).not.toHaveBeenCalled();
  });

  it("retains existing configured credentials on a noninteractive rerun", async () => {
    const fetchMock = fixture();
    const ctx = nonInteractiveContext();
    ctx.config = {
      models: {
        providers: {
          omlx: {
            baseUrl: "http://127.0.0.1:8000/v1",
            apiKey: "existing-fixture-key",
            models: [],
          },
        },
      },
    };
    const result = await configureOmlxNonInteractive(ctx);
    expect(result?.models?.providers?.omlx?.apiKey).toBe("existing-fixture-key");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { Authorization: "Bearer existing-fixture-key" },
      }),
    );
    expect(ctx.toApiKeyCredential).not.toHaveBeenCalled();
  });
});
