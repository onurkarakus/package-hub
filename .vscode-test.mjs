import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@vscode/test-cli";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    files: "out/test/**/*.test.js",
    workspaceFolder: path.join(root, "samples", "audit-quickfix"),
    mocha: {
        timeout: 180000,
    },
    env: {
        PACKAGEHUB_DISABLE_STARTUP_SCAN: "1",
    },
});
