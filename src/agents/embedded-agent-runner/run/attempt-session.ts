import type { CreateAgentSessionOptions } from "../../sessions/index.js";

/** Session options passed through the embedded runner's resource-loader seam. */
export type EmbeddedAgentSessionOptions = {
  cwd: string;
  agentDir: string;
  authStorage: unknown;
  modelRegistry: unknown;
  model: unknown;
  thinkingLevel: unknown;
  tools: NonNullable<CreateAgentSessionOptions["tools"]>;
  customTools: NonNullable<CreateAgentSessionOptions["customTools"]>;
  sessionManager: unknown;
  settingsManager: unknown;
  resourceLoader: unknown;
  withSessionWriteLock?: CreateAgentSessionOptions["withSessionWriteLock"];
};

/**
 * Create an embedded agent session while preserving the explicit resourceLoader
 * object supplied by the runner.
 */
export async function createEmbeddedAgentSessionWithResourceLoader<Result>(params: {
  createAgentSession: (options: EmbeddedAgentSessionOptions) => Promise<Result> | Result;
  options: EmbeddedAgentSessionOptions;
}): Promise<Result> {
  return await params.createAgentSession(params.options);
}
