import * as assert from "assert";
import { PackageInfo } from "../models/PackageInfo";
import { WarningExplainer } from "../services/WarningExplainer";

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

suite("WarningExplainer", () => {
    test("a vulnerability wins over outdated and deprecated", () => {
        const result = WarningExplainer.explain(
            "Newtonsoft.Json",
            "12.0.1",
            packageInfo({
                isVulnerable: true,
                severity: "High",
                latestVersion: "13.0.4",
                advisoryUrl: "https://github.com/advisories/GHSA-5crp-9r3c-p9vr",
            }),
            packageInfo({ isOutdated: true, latestVersion: "13.0.4" }),
            packageInfo({ isDeprecated: true })
        );

        assert.strictEqual(result.title, "Newtonsoft.Json");
        assert.strictEqual(result.severity, "High");
        assert.strictEqual(result.reason, "Known High severity vulnerability");
        assert.strictEqual(result.recommendedVersion, "13.0.4");
        assert.strictEqual(result.advisoryUrl, "https://github.com/advisories/GHSA-5crp-9r3c-p9vr");
        assert.strictEqual(result.isVulnerable, true);
        assert.strictEqual(result.isOutdated, false);
        assert.strictEqual(result.isDeprecated, false);
    });

    test("missing severity stays unknown", () => {
        const result = WarningExplainer.explain(
            "Newtonsoft.Json",
            "12.0.1",
            packageInfo({ isVulnerable: true })
        );

        assert.strictEqual(result.severity, "Unknown");
        assert.strictEqual(result.reason, "Known  severity vulnerability");
    });

    test("deprecated is used when the package is not vulnerable", () => {
        const result = WarningExplainer.explain(
            "Legacy.Pack",
            "1.0.0",
            undefined,
            packageInfo({ isOutdated: true, latestVersion: "2.0.0" }),
            packageInfo({ isDeprecated: true, latestVersion: "2.0.0", advisoryUrl: "https://example.test/deprecated" })
        );

        assert.strictEqual(result.reason, "This package is deprecated");
        assert.strictEqual(result.isDeprecated, true);
        assert.strictEqual(result.isOutdated, false);
        assert.strictEqual(result.advisoryUrl, "https://example.test/deprecated");
    });

    test("outdated is the last issue", () => {
        const result = WarningExplainer.explain(
            "Newtonsoft.Json",
            "12.0.1",
            undefined,
            packageInfo({ isOutdated: true, latestVersion: "13.0.4" })
        );

        assert.strictEqual(result.reason, "A newer version is available");
        assert.strictEqual(result.recommendedVersion, "13.0.4");
        assert.strictEqual(result.isOutdated, true);
    });

    test("a clean package has no issue", () => {
        const result = WarningExplainer.explain("Newtonsoft.Json", "13.0.4");

        assert.strictEqual(result.reason, "No known issues found in the last scan");
        assert.strictEqual(result.isVulnerable, false);
        assert.strictEqual(result.isOutdated, false);
        assert.strictEqual(result.isDeprecated, false);
    });
});
