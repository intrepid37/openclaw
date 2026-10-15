import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import {
  resolveProviderRequestHeaders,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import { OMLX_DEFAULT_BASE_URL, OMLX_PROVIDER_ID } from "./defaults.js";

type ConnectionContext = { config: OpenClawConfig; env: NodeJS.ProcessEnv };

export async function resolveOmlxSecret(
  params: ConnectionContext,
  value: unknown,
  path: string,
): Promise<string | undefined> {
  const result = await resolveConfiguredSecretInputString({
    config: params.config,
    env: params.env,
    value,
    path,
  });
  if (result.unresolvedRefReason) {
    throw new Error(result.unresolvedRefReason);
  }
  return result.value;
}

export async function resolveOmlxHeaders(
  params: ConnectionContext,
  configured: ModelProviderConfig | undefined,
): Promise<{ headers: Record<string, string>; hasHeaderAuth: boolean }> {
  const resolve = (value: unknown, path: string) => resolveOmlxSecret(params, value, path);
  const resolveHeaders = async (
    inputs: Record<string, unknown> | undefined,
    path: string,
    replacedNames: ReadonlySet<string>,
  ) => {
    const resolved: Record<string, string> = {};
    for (const [name, value] of Object.entries(inputs ?? {})) {
      if (replacedNames.has(name.trim().toLowerCase())) {
        continue;
      }
      const header = await resolve(value, `${path}.${name}`);
      if (header) {
        resolved[name] = header;
      }
    }
    return resolved;
  };
  const auth = configured?.request?.auth;
  const resolvedAuth =
    auth?.mode === "authorization-bearer"
      ? {
          ...auth,
          token: (await resolve(auth.token, "models.providers.omlx.request.auth.token")) ?? "",
        }
      : auth?.mode === "header"
        ? {
            ...auth,
            value: (await resolve(auth.value, "models.providers.omlx.request.auth.value")) ?? "",
          }
        : auth;
  const authHeaderNames = new Set<string>();
  if (auth && auth.mode !== "provider-default") {
    authHeaderNames.add("authorization");
    if (auth.mode === "header") {
      authHeaderNames.add(auth.headerName.trim().toLowerCase());
    }
  }
  // Resolve only effective headers so obsolete secrets cannot block an override.
  const requestHeaders = await resolveHeaders(
    configured?.request?.headers,
    "models.providers.omlx.request.headers",
    authHeaderNames,
  );
  const replacedDefaults = new Set([
    ...authHeaderNames,
    ...Object.keys(requestHeaders).map((name) => name.trim().toLowerCase()),
  ]);
  const headers =
    resolveProviderRequestHeaders({
      provider: OMLX_PROVIDER_ID,
      baseUrl: configured?.baseUrl ?? OMLX_DEFAULT_BASE_URL,
      defaultHeaders: await resolveHeaders(
        configured?.headers,
        "models.providers.omlx.headers",
        replacedDefaults,
      ),
      request: sanitizeConfiguredModelProviderRequest({
        headers: requestHeaders,
        auth: resolvedAuth,
      }),
    }) ?? {};
  return {
    headers,
    hasHeaderAuth:
      (auth !== undefined && auth.mode !== "provider-default") ||
      Object.keys(headers).some((name) => name.toLowerCase() === "authorization"),
  };
}
