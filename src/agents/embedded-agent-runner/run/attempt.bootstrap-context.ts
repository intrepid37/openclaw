import path from "node:path";
import { isAcpSessionKey, isSubagentSessionKey } from "../../../routing/session-key.js";
import type { EmbeddedContextFile } from "../../embedded-agent-helpers.js";

/** Only top-level user sessions own primary workspace bootstrap injection. */
export function isPrimaryBootstrapRun(sessionKey?: string): boolean {
  return !isSubagentSessionKey(sessionKey) && !isAcpSessionKey(sessionKey);
}

function isRelativePathInsideOrEqual(relativePath: string): boolean {
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

/**
 * Rebase injected context-file paths from the real workspace to the effective
 * attempt workspace while leaving out-of-workspace files untouched.
 */
export function remapInjectedContextFilesToWorkspace(params: {
  files: EmbeddedContextFile[];
  sourceWorkspaceDir: string;
  targetWorkspaceDir: string;
}): EmbeddedContextFile[] {
  if (params.sourceWorkspaceDir === params.targetWorkspaceDir) {
    return params.files;
  }
  return params.files.map((file) => {
    const relative = path.relative(params.sourceWorkspaceDir, file.path);
    // Only remap paths that remain inside the source workspace; external
    // context files keep their absolute path instead of being pulled into the sandbox.
    const canRemap = isRelativePathInsideOrEqual(relative);
    return canRemap
      ? {
          ...file,
          path:
            relative === ""
              ? params.targetWorkspaceDir
              : path.join(params.targetWorkspaceDir, relative),
        }
      : file;
  });
}
