#!/usr/bin/env node
// Manual macOS proof: relocated, signed standalone Doctor with isolated state.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { runManagedCommand } from "./lib/managed-child-process.mts";

const [source, ...flags] = process.argv.slice(2);
assert.equal(process.platform, "darwin", "This proof requires macOS sandbox-exec and APFS.");
assert(
  source && flags.every((flag) => flag === "--deny-local-ipc"),
  "Usage: node scripts/verify-standalone-doctor.mjs <standalone-directory> [--deny-local-ipc]",
);
const denyLocalIpc = flags.includes("--deny-local-ipc");
// Darwin's sockaddr_un limit includes TMPDIR, the private directory, and socket name.
const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/oc-doctor-"));
try {
  const runtime = path.join(root, "runtime");
  execFileSync("/bin/cp", ["-cR", fs.realpathSync(source), runtime]);
  const manifest = JSON.parse(fs.readFileSync(path.join(runtime, "manifest.json"), "utf8"));
  const executable = path.join(runtime, "openclaw");
  const sandbox = path.join(root, "doctor.sb");
  fs.writeFileSync(
    sandbox,
    `(version 1)
(allow default)
(deny network*)
(deny file-write*)
(deny file-read* (subpath (param "ORIGINAL_HOME")))
(allow file-read* file-write* (subpath (param "ISOLATED_ROOT")))
(allow file-write* (literal "/dev/null"))
(deny process-exec (literal "/bin/launchctl"))
(deny mach-lookup
  (global-name "com.apple.cfprefsd.daemon")
  (global-name "com.apple.cfprefsd.agent")
  (local-name "com.apple.cfprefsd.agent")
  (global-name "com.apple.SecurityServer")
  (global-name "com.apple.securityd")
  (global-name "com.apple.securityd.xpc"))
(deny ipc-posix-shm-read* (ipc-posix-name-prefix "apple.cfprefs."))
(deny file-read* file-write* (subpath "/Library/Keychains"))
(deny file-read*
  (subpath "/opt/homebrew/opt/sqlite")
  (subpath "/usr/local/opt/sqlite")
  (literal "/opt/local/lib/libsqlite3.dylib"))
${
  denyLocalIpc
    ? ""
    : `(allow network-bind
  (local unix-socket (subpath (param "ISOLATED_ROOT"))))
(allow network-outbound
  (remote unix-socket (subpath (param "ISOLATED_ROOT"))))`
}
`,
  );
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const config = path.join(root, "openclaw.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      agents: { defaults: { workspace }, entries: { main: {} } },
      memory: {
        search: {
          enabled: true,
          provider: "auto",
          sources: ["memory"],
          store: { vector: { enabled: true } },
        },
      },
    }),
  );
  const env = {
    HOME: root,
    CFFIXED_USER_HOME: root,
    TMPDIR: root,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_CONFIG_PATH: config,
    OPENCLAW_NO_RESPAWN: "1",
  };
  const prefix = [
    "-D",
    `ORIGINAL_HOME=${os.userInfo().homedir}`,
    "-D",
    `ISOLATED_ROOT=${root}`,
    "-f",
    sandbox,
    "/usr/bin/arch",
    process.arch === "arm64" ? "-arm64" : "-x86_64",
    executable,
  ];
  const results = [];
  for (const args of [["--version"], ["gateway", "--help"], ["doctor", "--non-interactive"]]) {
    let output = "";
    const started = performance.now();
    const code = await runManagedCommand({
      bin: "/usr/bin/sandbox-exec",
      args: [...prefix, ...args],
      cwd: root,
      env,
      timeoutMs: 60_000,
      requireProcessTreeExit: true,
      stdio: ["ignore", "pipe", "pipe"],
      onReady(child) {
        for (const stream of [child.stdout, child.stderr]) {
          stream.on("data", (data) => {
            output += data.toString();
          });
        }
      },
    });
    const doctor = args[0] === "doctor";
    if (doctor && denyLocalIpc) {
      assert.equal(code, 1, output);
      assert.match(output, /snapshot|Spawn broker/iu);
      assert.doesNotMatch(output, /Doctor complete/u);
    } else {
      assert.equal(code, 0, output);
      if (doctor) {
        assert.match(output, /Doctor complete/u);
        assert.doesNotMatch(
          output,
          /snapshot allocation|Dreaming cron inspection remains pending/iu,
        );
      }
    }
    results.push({
      command: args.join(" "),
      code,
      elapsedMs: Math.round(performance.now() - started),
    });
  }
  console.log(
    JSON.stringify({
      mode: manifest.mode,
      commit: manifest.openclaw.commit,
      denyLocalIpc,
      results,
    }),
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
