import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@vscode/test-cli";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    // VSCODE_TEST_VERSION=1.74.0 runs the tests on that VS Code (see npm run test:min).
    version: process.env.VSCODE_TEST_VERSION || "stable",
    files: "out/test/**/*.test.js",
    workspaceFolder: path.join(root, "samples", "audit-quickfix"),
    mocha: {
        timeout: 180000,
    },
    env: {
        PACKAGEHUB_DISABLE_STARTUP_SCAN: "1",
    },
});
