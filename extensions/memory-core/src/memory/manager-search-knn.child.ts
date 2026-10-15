// Serial sqlite-vec queries stay OS-killable even while native SQLite is busy.
import {
  ensureSqliteLibrarySelected,
  loadSqliteVecExtension,
  openNodeSqliteDatabase,
  supportsNodeSqliteExtensionLoading,
} from "openclaw/plugin-sdk/memory-core-host-engine-knn";
import {
  runVectorKnnQuery,
  type VectorKnnRequest,
  type VectorKnnResponse,
} from "./manager-search-knn.js";

const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;

export type VectorKnnChildInput = {
  databasePath: string;
  extensionPath?: string;
  sqliteLibraryPath?: string;
  request: VectorKnnRequest;
};

export type VectorKnnChildResult =
  | { status: "ok"; value: VectorKnnResponse }
  | { status: "failed"; error: string };

async function run(input: VectorKnnChildInput): Promise<VectorKnnResponse> {
  ensureSqliteLibrarySelected({ explicitPath: input.sqliteLibraryPath });
  const extensionLoadingSupported = supportsNodeSqliteExtensionLoading();
  const db = openNodeSqliteDatabase(input.databasePath, {
    allowExtension: extensionLoadingSupported,
    readOnly: true,
  });
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000");
    if (extensionLoadingSupported) {
      const loaded = await loadSqliteVecExtension({ db, extensionPath: input.extensionPath });
      if (loaded.ok) {
        return runVectorKnnQuery(db, input.request);
      }
    }
    return { rows: [], fallbackScanRequired: true };
  } finally {
    db.close();
  }
}

function writeResult(result: VectorKnnChildResult): void {
  let payload = Buffer.from(JSON.stringify(result), "utf8");
  if (payload.byteLength > MAX_STDOUT_BYTES) {
    payload = Buffer.from(
      JSON.stringify({
        status: "failed",
        error: "memory vector KNN child result is too large",
      }),
      "utf8",
    );
  }
  process.stdout.write(Buffer.concat([payload, Buffer.from("\n")]));
}

const chunks: Buffer[] = [];
let inputBytes = 0;
for await (const chunk of process.stdin) {
  inputBytes += chunk.byteLength;
  const newline = chunk.indexOf(10);
  if (inputBytes > MAX_STDIN_BYTES + (newline >= 0 ? 1 : 0)) {
    throw new Error("memory vector KNN child input is too large");
  }
  chunks.push(chunk);
  if (newline < 0) {
    continue;
  }
  // The parent sends one request at a time; coalesced frames violate that contract.
  if (newline !== chunk.length - 1) {
    throw new Error("invalid memory vector KNN child framing");
  }
  const input: VectorKnnChildInput = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  chunks.length = 0;
  inputBytes = 0;
  try {
    // Reopen for each query so publication and path replacement stay visible.
    writeResult({ status: "ok", value: await run(input) });
  } catch (error) {
    writeResult({
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
