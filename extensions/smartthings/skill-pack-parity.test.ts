import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workspaceSkillRoot = path.join(process.cwd(), "skills", "smartthings");
const pluginSkillRoot = path.join(
  process.cwd(),
  "extensions",
  "smartthings",
  "skills",
  "smartthings",
);

describe("smartthings skill pack parity", () => {
  it("keeps the workspace SKILL.md identical to the plugin-shipped copy", async () => {
    const [workspaceSkill, pluginSkill] = await Promise.all([
      fs.readFile(path.join(workspaceSkillRoot, "SKILL.md"), "utf8"),
      fs.readFile(path.join(pluginSkillRoot, "SKILL.md"), "utf8"),
    ]);

    expect(workspaceSkill).toBe(pluginSkill);
  });

  it("keeps workspace launcher shims pointed at the plugin-shipped scripts", async () => {
    const shims = [
      { file: "bin/_smartthings-client.js", statement: "export * from" },
      { file: "bin/command-device.js", statement: 'import "' },
      { file: "bin/get-tv-state.js", statement: 'import "' },
      { file: "bin/list-devices.js", statement: 'import "' },
    ] as const;

    for (const shim of shims) {
      const workspacePath = path.join(workspaceSkillRoot, shim.file);
      const pluginPath = path.join(pluginSkillRoot, shim.file);
      const source = await fs.readFile(workspacePath, "utf8");
      const expectedImportPath = toImportPath(
        path.relative(path.dirname(workspacePath), pluginPath),
      );

      expect(source).toContain(shim.statement);
      expect(source).toContain(`"${expectedImportPath}"`);
    }
  });
});

function toImportPath(value: string): string {
  const normalized = value.replaceAll(path.sep, "/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}
