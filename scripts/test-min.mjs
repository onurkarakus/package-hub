// Runs the extension tests on the oldest VS Code that package.json supports.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const version = manifest.engines.vscode.replace(/^[\^~>=]+/, "");
const result = spawnSync("npx", ["vscode-test"], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, VSCODE_TEST_VERSION: version },
});
process.exit(result.status ?? 1);
