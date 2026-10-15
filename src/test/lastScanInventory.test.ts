import * as assert from "assert";
import * as vscode from "vscode";
import { PackageInfo } from "../models/PackageInfo";
import { restoreLastScan, saveLastScan } from "../services/LastScanStore";
import { ScanState } from "../services/ScanState";

function memoryState(initial: Record<string, unknown> = {}): vscode.Memento {
    const values = new Map<string, unknown>(Object.entries(initial));
    return {
        keys: () => [...values.keys()],
        get: <T>(key: string, defaultValue?: T) => {
            if (!values.has(key)) {
                return defaultValue as T;
            }
            return values.get(key) as T;
        },
        update: async (key: string, value: unknown) => {
            values.set(key, value);
        },
    };
}

function installedPackage(): PackageInfo {
    return {
        id: "Serilog",
        version: "4.0.0",
        isVulnerable: false,
        isOutdated: false,
        isDeprecated: false,
        isTransitive: false,
        projects: ["Api"],
    };
}

suite("Last scan inventory", () => {
    teardown(() => {
        ScanState.setResults([], [], []);
    });

    test("a saved inventory comes back", async () => {
        const state = memoryState();
        ScanState.setResults([], [], [], new Date("2026-10-15T00:00:00Z"), [installedPackage()], ["Api"]);
        await saveLastScan(state);
        ScanState.setResults([], [], []);

        assert.strictEqual(restoreLastScan(state), true);
        assert.strictEqual(ScanState.findInstalled("Serilog")?.version, "4.0.0");
        assert.deepStrictEqual(ScanState.getProvenProjects(), ["Api"]);
    });

    test("an older record without an inventory draws no current packages", () => {
        ScanState.setResults([], [], [], new Date(), [installedPackage()], ["Api"]);
        const restored = restoreLastScan(memoryState({
            "packageHub.lastScan": {
                vulnerable: [],
                outdated: [],
                deprecated: [],
                scannedAt: "2026-10-14T00:00:00.000Z",
                hasCpm: false,
            },
        }));

        assert.strictEqual(restored, true);
        assert.strictEqual(ScanState.findInstalled("Serilog"), undefined);
        assert.deepStrictEqual(ScanState.getProvenProjects(), []);
    });

    test("a later result clears a previous inventory", () => {
        ScanState.setResults([], [], [], new Date(), [installedPackage()], ["Api"]);
        ScanState.setResults([], [], []);

        assert.strictEqual(ScanState.findInstalled("Serilog"), undefined);
        assert.deepStrictEqual(ScanState.getProvenProjects(), []);
    });
});
