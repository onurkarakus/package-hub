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
        ScanState.setUnreadableProjects([]);
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

    test("no scanned project is neutral, not healthy", () => {
        ScanState.setResults([], [], [], new Date(), [], []);
        ScanState.setAuditDataGap(false);
        const status = ScanState.statusBarLabel();
        assert.strictEqual(status.neutral, true);
        assert.strictEqual(status.text, "$(package) PackageHub");
    });

    test("an unreadable project is not healthy", () => {
        ScanState.setResults([], [], [], new Date(), [], ["AuditQuickFix"]);
        ScanState.setUnreadableProjects(["Consumer"]);
        ScanState.setAuditDataGap(false);
        const status = ScanState.statusBarLabel();
        assert.strictEqual(status.healthy, false);
        assert.strictEqual(status.text, "$(warning) 1 project not checked");
    });

    test("zero problems say healthy", () => {
        ScanState.setResults([], [], [], new Date(), [], ["AuditQuickFix"]);
        ScanState.setAuditDataGap(false);
        const status = ScanState.statusBarLabel();
        assert.strictEqual(status.healthy, true);
        assert.strictEqual(status.text, "$(check) Packages healthy");
    });
});
