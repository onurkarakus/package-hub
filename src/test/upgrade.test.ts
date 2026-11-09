import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { restoreLastScan } from "../services/LastScanStore";
import { ScanState } from "../services/ScanState";
import { projectScope } from "../services/UpdateScope";
import { buildHealthReport } from "../services/HealthReport";
import { buildVulnerabilityReport } from "../services/VulnerabilityReport";
import { currentDashboardState } from "../webview/HealthDashboardPanel";

const root = path.resolve(__dirname, "..", "..");

/**
 * Commands of 0.0.4, the last version on the Marketplace, plus Get Started
 * from 0.1.0. Keybindings and tasks may point at any of them.
 */
const OLD_COMMANDS = [
    "packageHub.scanWorkspace", "packageHub.showHealthDashboard", "packageHub.explainSelectedPackage", "packageHub.restoreAll",
    "packageHub.updateVulnerable", "packageHub.updateSelectedPackage", "packageHub.showPackageInfo", "packageHub.openNugetPage",
    "packageHub.showDependencyGraph", "packageHub.copyHealthReport", "packageHub.copyVulnerabilityReport",
    "packageHub.updateHighestPatch", "packageHub.updateHighestMinor", "packageHub.whyPackage", "packageHub.ignorePackage",
    "packageHub.unignorePackage", "packageHub.removePackage", "packageHub.updateLinePatch", "packageHub.updateLineLatest",
    "packageHub.openLineAdvisory", "packageHub.openWalkthrough",
];

function memento(values: Record<string, unknown>): vscode.Memento {
    return {
        keys: () => Object.keys(values),
        get: <T>(key: string, fallback?: T) => (key in values ? values[key] : fallback) as T,
        update: async () => undefined,
    };
}

suite("Upgrading from 0.0.4 and 0.1.0", () => {
    teardown(() => {
        ScanState.setResults([], [], []);
    });

    test("every earlier command is still contributed and registered", async () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
        const contributed = new Set(manifest.contributes.commands.map((item: { command: string }) => item.command));
        await vscode.extensions.getExtension("onurkarakus.package-hub")?.activate();
        const registered = new Set(await vscode.commands.getCommands(true));
        for (const command of OLD_COMMANDS) {
            assert.ok(contributed.has(command), `${command} is not contributed`);
            assert.ok(registered.has(command), `${command} is not registered`);
        }
    });

    test("updateVulnerable without a projects argument stays unscoped", () => {
        assert.strictEqual(projectScope(undefined), undefined);
        assert.strictEqual(projectScope(null), undefined);
        assert.strictEqual(projectScope({ projects: ["Api"] }), undefined);
    });

    test("the removed dashboardViewMode setting is never read", () => {
        for (const file of ["dist/extension.js", "media/dashboard.js"]) {
            const text = fs.readFileSync(path.join(root, file), "utf8");
            assert.ok(!text.includes("dashboardViewMode"), `${file} still reads dashboardViewMode`);
        }
    });

    test("a last scan saved by 0.0.4 restores and feeds the dashboard and reports", async () => {
        // 0.0.4 saved no direct projects, per-project versions, entries or
        // per-advisory severities.
        const record = {
            vulnerable: [{
                id: "Newtonsoft.Json", version: "12.0.1", isVulnerable: true, isOutdated: false, isDeprecated: false,
                isTransitive: false, severity: "High", advisoryUrl: "https://github.com/advisories/GHSA-5crp-9r3c-p9vr",
                projects: ["Api"],
            }],
            outdated: [{
                id: "Moq", version: "4.18.4", latestVersion: "4.20.72", isVulnerable: false, isOutdated: true, isDeprecated: false,
                isTransitive: false, projects: ["Api.Tests"],
            }],
            deprecated: [],
            scannedAt: "2026-11-05T10:00:00.000Z",
            hasCpm: false,
        };
        assert.strictEqual(restoreLastScan(memento({ "packageHub.lastScan": record })), true);
        const state = await currentDashboardState();
        const pkg = state.packages.find((item) => item.id === "Newtonsoft.Json")!;
        assert.strictEqual(pkg.vulnerable, true);
        assert.strictEqual(pkg.severity, "high");
        assert.deepStrictEqual(pkg.advisories.map((item) => item.severity), ["high"]);
        assert.strictEqual(state.score.vulnerable, 8);
        assert.deepStrictEqual(pkg.directIn, ["Api"]);
        assert.strictEqual(state.packages.find((item) => item.id === "Moq")!.outdated, true);
        assert.match(buildHealthReport() || "", /Newtonsoft\.Json/);
        assert.match(buildVulnerabilityReport() || "", /Newtonsoft\.Json/);
    });
});
