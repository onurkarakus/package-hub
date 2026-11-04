import * as assert from "assert";
import { buildUpdateSummary } from "../services/UpdateSummary";

suite("Update summary", () => {
    test("a patch for a direct reference that closes an advisory", () => {
        const summary = buildUpdateSummary({
            packageId: "Newtonsoft.Json",
            targetVersion: "12.0.3",
            projects: [{ name: "Api", fromVersion: "12.0.1", relation: "direct" }],
            advisories: [{ url: "https://github.com/advisories/GHSA-1", label: "GHSA-1", verdict: "closed" }],
            centralFiles: [],
            usesCentralPackageManagement: false,
        });
        assert.strictEqual(summary.heading, "Newtonsoft.Json 12.0.1 → 12.0.3");
        assert.strictEqual(summary.change, "patch");
        assert.ok(summary.lines.includes("Closes GHSA-1."));
        assert.ok(summary.lines.includes("Direct reference in: Api."));
        assert.ok(summary.lines.some((line) => /project files/.test(line)));
    });

    test("major, transitive, CPM file, prerelease and an open advisory", () => {
        const summary = buildUpdateSummary({
            packageId: "System.Text.Json",
            targetVersion: "9.0.0-rc.1",
            projects: [
                { name: "Api", fromVersion: "8.0.4", relation: "direct" },
                { name: "Worker", fromVersion: "6.0.0", relation: "transitive" },
            ],
            advisories: [{ url: "https://x", label: "GHSA-2", verdict: "open" }],
            centralFiles: ["Directory.Packages.props"],
            usesCentralPackageManagement: true,
            releaseAgeNotice: "Age gate notice.",
            youngerThanAgeGate: true,
        });
        assert.strictEqual(summary.heading, "System.Text.Json 8.0.4 / 6.0.0 → 9.0.0-rc.1");
        assert.strictEqual(summary.change, "major");
        const text = summary.lines.join("\n");
        assert.match(text, /Breaking changes/);
        assert.match(text, /different versions now: 8\.0\.4, 6\.0\.0/);
        assert.match(text, /stable version to a prerelease/);
        assert.match(text, /GHSA-2 stays open in 9\.0\.0-rc\.1/);
        assert.match(text, /Transitive in: Worker\. A direct PackageReference will be added/);
        assert.match(text, /Edits Directory\.Packages\.props/);
        assert.match(text, /younger than packageHub\.minimumReleaseAge/);
        assert.match(text, /Age gate notice\./);
    });

    test("no target and unknown verdicts", () => {
        const summary = buildUpdateSummary({
            packageId: "A",
            projects: [{ name: "Api", fromVersion: "[1.0.0, )", relation: "direct" }],
            advisories: [{ url: "https://x", label: "GHSA-3", verdict: "unknown" }],
            centralFiles: [],
            usesCentralPackageManagement: true,
        });
        assert.strictEqual(summary.heading, "A → the latest version dotnet picks");
        assert.strictEqual(summary.change, "unknown");
        assert.match(summary.lines.join("\n"), /No local record says whether the new version closes GHSA-3/);
        assert.match(summary.lines.join("\n"), /writes the version to Directory\.Packages\.props/);
    });
});
