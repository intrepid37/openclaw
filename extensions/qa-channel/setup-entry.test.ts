// Qa Channel tests cover setup entry plugin behavior.
import { beforeAll, describe, expect, it } from "vitest";
import setupEntry from "./setup-entry.js";

describe("qa-channel setup entry", () => {
  let setupPlugin: ReturnType<typeof setupEntry.loadSetupPlugin>;

  beforeAll(() => {
    setupPlugin = setupEntry.loadSetupPlugin();
  });

  it("loads the bundled setup plugin through the setup-entry contract", () => {
    expect(setupEntry.kind).toBe("bundled-channel-setup-entry");

    expect(setupPlugin.id).toBe("qa-channel");
    expect(setupPlugin.capabilities.chatTypes).toEqual(["direct", "group"]);
    expect(
      setupPlugin.config.resolveAccount(
        {
          agents: { defaults: { mediaMaxMb: 8 } },
          channels: {
            "qa-channel": { mediaMaxMb: 2, accounts: { Limited: { mediaMaxMb: 1 / 1024 } } },
          },
        },
        "limited",
      ),
    ).toMatchObject({ accountId: "limited", mediaMaxBytes: 1024 });
  });

  it.each(["default", "work"])(
    "updates only the %s account without mutating config",
    (accountId) => {
      const cfg = {
        agents: { defaults: { mediaMaxMb: 8 } },
        channels: {
          "qa-channel": {
            baseUrl: "http://localhost:8787",
            botUserId: "existing",
            accounts: { work: { botDisplayName: "Work" }, other: { enabled: false } },
          },
        },
      };
      const original = structuredClone(cfg);
      const contract = setupPlugin.setupContract!;
      const parsed = contract.parseInput({ baseUrl: "http://localhost:9000", botUserId: "new" });
      if (!parsed.ok) {
        throw new Error(parsed.error);
      }
      const next = contract.applyAccountConfig({ cfg, accountId, input: parsed.value });
      expect(cfg).toEqual(original);
      expect(next.agents).toEqual(cfg.agents);
      expect(setupPlugin.config.resolveAccount(next, accountId)).toMatchObject({
        baseUrl: "http://localhost:9000",
        botUserId: "new",
      });
      expect(next.channels?.["qa-channel"]).toMatchObject({
        accounts: { other: { enabled: false } },
      });
      if (accountId === "work") {
        expect(next.channels?.["qa-channel"]).toMatchObject({
          baseUrl: "http://localhost:8787",
          accounts: { work: { botDisplayName: "Work" } },
        });
      }
    },
  );
});
