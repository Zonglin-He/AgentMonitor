import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const testDirectories = [];

function collectTestDirectories(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const child = join(directory, entry.name);
    if (entry.name === "__tests__") {
      testDirectories.push(child);
      continue;
    }
    collectTestDirectories(child);
  }
}

collectTestDirectories(join(packageRoot, "src"));

if (testDirectories.length > 0) {
  const oxlintCli = join(
    packageRoot,
    "node_modules",
    "oxlint",
    "bin",
    "oxlint",
  );
  const result = spawnSync(
    process.execPath,
    [
      oxlintCli,
      ...testDirectories,
      "--type-aware",
      "-c",
      "../../.oxlintrc.typeaware.json",
    ],
    { cwd: packageRoot, stdio: "inherit" },
  );

  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
}
