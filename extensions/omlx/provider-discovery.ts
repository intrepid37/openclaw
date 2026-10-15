import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { OMLX_API_KEY_ENV_VAR, OMLX_LOCAL_API_KEY, OMLX_PROVIDER_ID } from "./defaults.js";

export default {
  id: OMLX_PROVIDER_ID,
  label: "oMLX",
  docsPath: "/providers/omlx",
  envVars: [OMLX_API_KEY_ENV_VAR],
  auth: [],
  catalog: {
    order: "late",
    run: async (ctx) => {
      const { discoverOmlxProvider } = await import("./setup.js");
      return discoverOmlxProvider(ctx);
    },
  },
  resolveSyntheticAuth: ({ providerConfig }) => {
    if (
      providerConfig?.apiKey ||
      (providerConfig?.request?.auth && providerConfig.request.auth.mode !== "provider-default") ||
      Object.keys({ ...providerConfig?.headers, ...providerConfig?.request?.headers }).some(
        (name) => name.toLowerCase() === "authorization",
      )
    ) {
      return undefined;
    }
    return {
      apiKey: OMLX_LOCAL_API_KEY,
      source: "oMLX local server",
      mode: "api-key",
    };
  },
} satisfies ProviderPlugin;
