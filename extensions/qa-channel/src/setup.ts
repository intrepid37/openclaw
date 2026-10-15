import type { ChannelSetupInput } from "openclaw/plugin-sdk/channel-setup";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_ACCOUNT_ID } from "./accounts.js";
import type { CoreConfig } from "./types.js";

export type QaChannelSetupInput = ChannelSetupInput & {
  baseUrl?: string;
  botUserId?: string;
  botDisplayName?: string;
};

export function applyQaSetup(params: {
  cfg: OpenClawConfig;
  accountId: string;
  input: QaChannelSetupInput;
}): OpenClawConfig {
  const section = (params.cfg as CoreConfig).channels?.["qa-channel"] ?? {};
  const target =
    params.accountId === DEFAULT_ACCOUNT_ID
      ? { ...section }
      : { ...section.accounts?.[params.accountId] };
  if (params.input.baseUrl !== undefined) {
    target.baseUrl = params.input.baseUrl;
  }
  if (params.input.botUserId !== undefined) {
    target.botUserId = params.input.botUserId;
  }
  if (params.input.botDisplayName !== undefined) {
    target.botDisplayName = params.input.botDisplayName;
  }
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      "qa-channel":
        params.accountId === DEFAULT_ACCOUNT_ID
          ? target
          : { ...section, accounts: { ...section.accounts, [params.accountId]: target } },
    },
  };
}
