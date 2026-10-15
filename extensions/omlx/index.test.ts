import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function embeddingAdapter() {
  const adapter = capturePluginRegistration(plugin).embeddingProviders[0];
  if (!adapter) {
    throw new Error("oMLX did not register its embedding provider");
  }
  return adapter;
}

describe("oMLX registered embedding provider", () => {
  it.each([
    {
      name: "the default keyless server",
      config: {},
      remote: undefined,
      endpoint: "http://127.0.0.1:8000/v1/embeddings",
      authorization: null,
    },
    {
      name: "the configured provider connection",
      config: {
        models: {
          providers: {
            omlx: {
              baseUrl: "http://127.0.0.1:18001/v1",
              api: "openai-completions",
              apiKey: "synthetic-provider-key",
              models: [],
            },
          },
        },
      },
      remote: undefined,
      endpoint: "http://127.0.0.1:18001/v1/embeddings",
      authorization: "Bearer synthetic-provider-key",
    },
    {
      name: "a destination-owned memory override",
      config: {
        models: {
          providers: {
            omlx: {
              baseUrl: "http://127.0.0.1:18001/v1",
              api: "openai-completions",
              apiKey: "synthetic-provider-key",
              request: {
                auth: {
                  mode: "authorization-bearer",
                  token: "${OMLX_UNSET_TEST_AUTH}",
                },
              },
              models: [],
            },
          },
        },
      },
      remote: { baseUrl: "http://127.0.0.1:18002/v1", apiKey: "synthetic-memory-key" },
      endpoint: "http://127.0.0.1:18002/v1/embeddings",
      authorization: "Bearer synthetic-memory-key",
    },
  ] satisfies Array<{
    name: string;
    config: OpenClawConfig;
    remote: { baseUrl: string; apiKey: string } | undefined;
    endpoint: string;
    authorization: string | null;
  }>)("embeds through $name", async ({ config, remote, endpoint, authorization }) => {
    const requests: Array<{ url: string; body: unknown; authorization: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return Response.json({
          data: [
            { index: 1, embedding: [0, 1] },
            { index: 0, embedding: [1, 0] },
          ],
        });
      }),
    );
    const result = await embeddingAdapter().create({
      config,
      model: "omlx/fixture-embedding",
      remote,
    });
    expect(result.provider?.id).toBe("omlx");
    expect(result.runtime?.id).toBe("omlx");
    await expect(result.provider?.embedBatch(["orchard", "spaceport"])).resolves.toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(requests).toEqual([
      {
        url: endpoint,
        body: { model: "fixture-embedding", input: ["orchard", "spaceport"] },
        authorization,
      },
    ]);
  });

  it.each([
    {
      name: "request headers",
      request: { headers: { authorization: "Bearer ${OMLX_EMBED_TEST_KEY}" } },
      authorization: "Bearer fixture-omlx-key",
      customKey: null,
    },
    {
      name: "bearer authentication",
      request: {
        auth: { mode: "authorization-bearer" as const, token: "${OMLX_EMBED_TEST_KEY}" },
      },
      authorization: "Bearer fixture-omlx-key",
      customKey: null,
    },
    {
      name: "custom header authentication",
      request: {
        auth: {
          mode: "header" as const,
          headerName: "X-oMLX-Key",
          value: "${OMLX_EMBED_TEST_KEY}",
        },
      },
      authorization: null,
      customKey: "fixture-omlx-key",
    },
  ])("inherits $name for embeddings", async ({ request, authorization, customKey }) => {
    vi.stubEnv("OMLX_EMBED_TEST_KEY", "fixture-omlx-key");
    let observedHeaders = new Headers();
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      observedHeaders = new Headers(init?.headers);
      return Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
    });
    vi.stubGlobal("fetch", fetch);
    const result = await embeddingAdapter().create({
      config: {
        models: {
          providers: {
            omlx: {
              baseUrl: "http://127.0.0.1:8000/v1",
              api: "openai-completions",
              apiKey: "stale-provider-key",
              headers: { Authorization: "Bearer stale-header" },
              request,
              models: [],
            },
          },
        },
      },
      model: "fixture-embedding",
    });
    await expect(result.provider?.embed("orchard")).resolves.toEqual([1, 0]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(observedHeaders.get("authorization")).toBe(authorization);
    expect(observedHeaders.get("x-omlx-key")).toBe(customKey);
  });

  it("preserves an explicit private-network denial", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { provider } = await embeddingAdapter().create({
      config: {
        models: {
          providers: {
            omlx: {
              baseUrl: "http://127.0.0.1:8000/v1",
              api: "openai-completions",
              request: { allowPrivateNetwork: false },
              models: [],
            },
          },
        },
      },
      model: "fixture-embedding",
    });
    await expect(provider?.embed("orchard")).rejects.toThrow(/private\/internal\/special-use/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

it("connects the registered setup and catalog hooks to the inference models endpoint", async () => {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) => {
      paths.push(new URL(String(url)).pathname);
      return Response.json({
        data: [{ id: "Qwen2.5-3B-Instruct-4bit", max_model_len: 32768 }],
      });
    }),
  );
  const provider = capturePluginRegistration(plugin).providers[0];
  const context = { config: {}, env: {} };
  await expect(provider?.auth[0]?.appGuidedSetup?.detect(context)).resolves.toMatchObject({
    modelRef: "omlx/Qwen2.5-3B-Instruct-4bit",
  });
  const catalog = await provider?.catalog?.run({
    ...context,
    providerIds: ["omlx"],
    resolveProviderApiKey: () => ({ apiKey: "omlx-local" }),
    resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
  });
  expect(catalog).toMatchObject({
    provider: { api: "openai-completions", models: [{ id: "Qwen2.5-3B-Instruct-4bit" }] },
  });
  expect(paths).toEqual(["/v1/models", "/v1/models"]);
});

it.each([
  { request: { headers: { Authorization: "Bearer synthetic-proxy-key" } } },
  { request: { auth: { mode: "authorization-bearer" as const, token: "synthetic-key" } } },
])("respects explicit request authentication when resolving local auth", (configured) => {
  const provider = capturePluginRegistration(plugin).providers[0];
  expect(
    provider?.resolveSyntheticAuth?.({
      provider: "omlx",
      config: {},
      providerConfig: {
        baseUrl: "http://127.0.0.1:8000/v1",
        models: [],
        ...configured,
      },
    }),
  ).toBeUndefined();
});
