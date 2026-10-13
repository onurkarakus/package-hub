import * as assert from "assert";
import { PackageInfo } from "../models/PackageInfo";
import { ScanState } from "../services/ScanState";

function packageInfo(patch: Partial<PackageInfo> = {}): PackageInfo {
    return {
        id: "Newtonsoft.Json",
        version: "12.0.1",
        isVulnerable: false,
        isOutdated: false,
        isDeprecated: false,
        isTransitive: false,
        projects: ["AuditQuickFix"],
        ...patch,
    };
}

suite("Status bar", () => {
    teardown(() => {
        ScanState.setResults([], [], []);
        ScanState.setAuditDataGap(false);
    });

    test("a vulnerability keeps the warning", () => {
        ScanState.setResults([
            packageInfo({ isVulnerable: true, severity: "High" }),
        ], [], []);
        ScanState.setAuditDataGap(false);
        const status = ScanState.statusBarLabel();
        assert.strictEqual(status.healthy, false);
        assert.strictEqual(status.text, "$(warning) 1 vuln · 0 outdated · 0 deprecated");
    });

    test("deprecated alone is not healthy", () => {
        ScanState.setResults([], [], [
            packageInfo({ id: "Old.Package", isDeprecated: true }),
        ]);
        ScanState.setAuditDataGap(false);
        const status = ScanState.statusBarLabel();
        assert.strictEqual(status.healthy, false);
        assert.strictEqual(status.text, "$(warning) 0 vuln · 0 outdated · 1 deprecated");
    });

    test("an audit gap alone is not healthy", () => {
        ScanState.setResults([], [], []);
        ScanState.setAuditDataGap(true);
        const status = ScanState.statusBarLabel();
        assert.strictEqual(status.healthy, false);
        assert.strictEqual(status.text, "$(warning) Audit source");
    });

    test("zero problems say healthy", () => {
        ScanState.setResults([], [], []);
        ScanState.setAuditDataGap(false);
        const status = ScanState.statusBarLabel();
        assert.strictEqual(status.healthy, true);
        assert.strictEqual(status.text, "$(check) Packages healthy");
    });
});
