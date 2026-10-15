import type { ProviderAppGuidedSetupContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildApiKeyCredential,
  ensureApiKeyFromEnvOrPrompt,
  type OpenClawConfig,
  type SecretInput,
  type SecretInputMode,
} from "openclaw/plugin-sdk/provider-auth";
import { selectPreferredLocalModelId } from "openclaw/plugin-sdk/provider-model-shared";
import {
  configureOpenAICompatibleSelfHostedProviderNonInteractive,
  type ProviderAuthContext,
  type ProviderAuthMethodNonInteractiveContext,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk/provider-setup";
import {
  OMLX_API_KEY_ENV_VAR,
  OMLX_DEFAULT_BASE_URL,
  OMLX_LOCAL_API_KEY,
  OMLX_PROVIDER_ID,
} from "./defaults.js";
import { listOmlxModels } from "./models.js";

export { discoverOmlxProvider } from "./models.js";

type Listing = NonNullable<Awaited<ReturnType<typeof listOmlxModels>>>;

function automaticModels(listing: Listing) {
  return listing.provider.models.filter((model) =>
    listing.rows.some(
      (row) =>
        row.model.id === model.id &&
        typeof row.model.max_model_len === "number" &&
        Number.isSafeInteger(row.model.max_model_len) &&
        row.model.max_model_len >= 16_384,
    ),
  );
}

function setupResult(listing: Listing, modelId: string): ProviderAuthResult {
  return {
    profiles: [],
    defaultModel: `${OMLX_PROVIDER_ID}/${modelId}`,
    configPatch: {
      models: { providers: { [OMLX_PROVIDER_ID]: listing.provider } },
    },
  };
}

export async function detectOmlxAvailability(ctx: ProviderAppGuidedSetupContext) {
  return (await listOmlxModels(ctx)) !== null;
}

export async function detectOmlx(ctx: ProviderAppGuidedSetupContext) {
  const listing = await listOmlxModels(ctx);
  const modelId = listing && selectPreferredLocalModelId(automaticModels(listing).map((m) => m.id));
  return modelId ? { modelRef: `${OMLX_PROVIDER_ID}/${modelId}`, detail: modelId } : null;
}

export async function prepareOmlx(
  ctx: ProviderAppGuidedSetupContext & { modelRef: string },
): Promise<ProviderAuthResult | null> {
  const listing = await listOmlxModels(ctx);
  const model =
    listing && automaticModels(listing).find((m) => `${OMLX_PROVIDER_ID}/${m.id}` === ctx.modelRef);
  return listing && model ? setupResult(listing, model.id) : null;
}

const unavailableMessage =
  "No oMLX chat models were found. Start oMLX, add a chat model, and check the base URL and API key before running setup again.";

export async function configureOmlxInteractive(
  ctx: ProviderAuthContext,
): Promise<ProviderAuthResult> {
  const baseUrl = await ctx.prompter.text({
    message: "oMLX base URL",
    initialValue: ctx.config.models?.providers?.omlx?.baseUrl ?? OMLX_DEFAULT_BASE_URL,
    validate: (value) => {
      try {
        const url = new URL(value ?? "");
        return ["http:", "https:"].includes(url.protocol) ? undefined : "Use an HTTP or HTTPS URL";
      } catch {
        return "Enter the oMLX OpenAI-compatible base URL, including /v1";
      }
    },
  });
  let credentialInput: SecretInput = "";
  let credentialMode: SecretInputMode | undefined;
  const apiKey = await ensureApiKeyFromEnvOrPrompt({
    config: ctx.config,
    env: ctx.env,
    workspaceDir: ctx.workspaceDir,
    provider: OMLX_PROVIDER_ID,
    envLabel: OMLX_API_KEY_ENV_VAR,
    promptMessage: "oMLX API key (leave blank if authentication is disabled)",
    normalize: (value) => value.trim(),
    validate: () => undefined,
    prompter: ctx.prompter,
    secretInputMode:
      ctx.secretInputMode ?? (ctx.allowSecretRefPrompt === false ? "plaintext" : undefined),
    setCredential: async (value, mode) => {
      credentialInput = value;
      credentialMode = mode;
    },
  });
  const listing = await listOmlxModels({
    ...ctx,
    env: ctx.env ?? process.env,
    baseUrl,
    apiKey,
  });
  if (!listing?.provider.models.length) {
    throw new Error(unavailableMessage);
  }
  const modelId = await ctx.prompter.select({
    message: "oMLX chat model",
    initialValue: selectPreferredLocalModelId(listing.provider.models.map((m) => m.id)),
    options: listing.provider.models.map((model) => ({ value: model.id, label: model.name })),
  });
  ctx.signal?.throwIfAborted();
  const result = setupResult(listing, modelId);
  listing.provider.apiKey = apiKey ? OMLX_API_KEY_ENV_VAR : OMLX_LOCAL_API_KEY;
  if (apiKey) {
    result.profiles = [
      {
        profileId: "omlx:default",
        credential: buildApiKeyCredential(OMLX_PROVIDER_ID, credentialInput, undefined, {
          secretInputMode: credentialMode,
        }),
      },
    ];
  }
  return result;
}

type NonInteractiveContext = Omit<ProviderAuthMethodNonInteractiveContext, "toApiKeyCredential">;

async function prepareNonInteractive(ctx: NonInteractiveContext) {
  const modelId = ctx.opts.customModelId?.trim();
  if (!modelId) {
    ctx.runtime.error(
      "oMLX setup requires --custom-model-id. List model IDs at the server's /v1/models endpoint.",
    );
    return null;
  }
  const resolved = await ctx.resolveApiKey({
    provider: OMLX_PROVIDER_ID,
    flagValue: ctx.opts.customApiKey,
    flagName: "--custom-api-key",
    envVar: OMLX_API_KEY_ENV_VAR,
    allowProfile:
      !ctx.opts.customBaseUrl ||
      ctx.opts.customBaseUrl.trim().replace(/\/+$/, "") ===
        (ctx.config.models?.providers?.omlx?.baseUrl ?? OMLX_DEFAULT_BASE_URL)
          .trim()
          .replace(/\/+$/, ""),
    required: false,
  });
  const listing = await listOmlxModels({
    config: ctx.config,
    env: process.env,
    baseUrl: ctx.opts.customBaseUrl,
    ...(resolved ? { apiKey: resolved.key } : {}),
  });
  if (!listing?.provider.models.some((model) => model.id === modelId)) {
    ctx.runtime.error(`${unavailableMessage} Requested model: ${modelId}.`);
    return null;
  }
  return { listing, modelId, resolved };
}

export async function validateOmlxNonInteractive(ctx: NonInteractiveContext): Promise<boolean> {
  return (await prepareNonInteractive(ctx)) !== null;
}

export async function configureOmlxNonInteractive(
  ctx: ProviderAuthMethodNonInteractiveContext,
): Promise<OpenClawConfig | null> {
  const prepared = await prepareNonInteractive(ctx);
  if (!prepared) {
    ctx.runtime.exit(1);
    return null;
  }
  const { listing, modelId, resolved } = prepared;
  const config = await configureOpenAICompatibleSelfHostedProviderNonInteractive({
    ctx: {
      ...ctx,
      opts: { ...ctx.opts, customApiKey: resolved?.key ?? OMLX_LOCAL_API_KEY },
      resolveApiKey: async () => resolved ?? { key: OMLX_LOCAL_API_KEY, source: "flag" },
    },
    providerId: OMLX_PROVIDER_ID,
    providerLabel: "oMLX",
    defaultBaseUrl: listing.provider.baseUrl,
    defaultApiKeyEnvVar: OMLX_API_KEY_ENV_VAR,
    modelPlaceholder: modelId,
  });
  if (!config?.models?.providers?.omlx) {
    return null;
  }
  config.models.providers.omlx = {
    ...listing.provider,
    apiKey: resolved
      ? resolved.key === OMLX_LOCAL_API_KEY
        ? OMLX_LOCAL_API_KEY
        : OMLX_API_KEY_ENV_VAR
      : listing.provider.apiKey,
  };
  return config;
}
