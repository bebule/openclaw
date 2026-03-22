import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const adapterDistDir = path.join(repoRoot, "adapter", "dist");
const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

await fs.rm(adapterDistDir, { recursive: true, force: true });

execFileSync(pnpmBin, ["exec", "tsc", "-p", "adapter/tsconfig.build.json"], {
  cwd: repoRoot,
  stdio: "inherit",
});

const builtFiles = await collectFiles(adapterDistDir);
const leakedTests = builtFiles.filter((filePath) => filePath.endsWith(".test.js"));

if (leakedTests.length > 0) {
  throw new Error(
    `SmartThings adapter build emitted test files: ${leakedTests.map((filePath) => path.relative(repoRoot, filePath)).join(", ")}`,
  );
}

async function collectFiles(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(rootDir, entry.name);
      if (entry.isDirectory()) {
        return collectFiles(entryPath);
      }
      return [entryPath];
    }),
  );
  return nested.flat();
}
