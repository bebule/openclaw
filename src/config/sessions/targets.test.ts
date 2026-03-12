import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "../../../test/helpers/temp-home.js";
import type { OpenClawConfig } from "../config.js";
import { resolveAllAgentSessionStoreTargets } from "./targets.js";

describe("resolveAllAgentSessionStoreTargets", () => {
  it("includes discovered on-disk agent stores alongside configured targets", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const opsSessionsDir = path.join(stateDir, "agents", "ops", "sessions");
      const retiredSessionsDir = path.join(stateDir, "agents", "retired", "sessions");
      await fs.mkdir(opsSessionsDir, { recursive: true });
      await fs.mkdir(retiredSessionsDir, { recursive: true });
      await fs.writeFile(path.join(opsSessionsDir, "sessions.json"), "{}", "utf8");
      await fs.writeFile(path.join(retiredSessionsDir, "sessions.json"), "{}", "utf8");

      const cfg: OpenClawConfig = {
        agents: {
          list: [{ id: "ops", default: true }],
        },
      };

      const targets = await resolveAllAgentSessionStoreTargets(cfg, { env: process.env });

      expect(targets).toEqual(
        expect.arrayContaining([
          {
            agentId: "ops",
            storePath: path.join(opsSessionsDir, "sessions.json"),
          },
          {
            agentId: "retired",
            storePath: path.join(retiredSessionsDir, "sessions.json"),
          },
        ]),
      );
      expect(
        targets.filter((target) => target.storePath === path.join(opsSessionsDir, "sessions.json")),
      ).toHaveLength(1);
    });
  });
});
