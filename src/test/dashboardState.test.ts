import * as assert from "assert";
import { PackageInfo } from "../models/PackageInfo";
import { firstFixedFromRanges, versionInsideRange } from "../utils/nugetAudit";
import { advisoryId, buildDashboardState, DashboardInput, findAction } from "../webview/DashboardState";

const GH = "https://github.com/advisories/";

/** Advisory ranges by package id and advisory id, like the NuGet vulnerability data. */
const RANGES: Record<string, Record<string, string[]>> = {
    "newtonsoft.json": { "GHSA-5crp-9r3c-p9vr": ["(, 13.0.1)"] },
    "system.text.json": { "GHSA-hh2w-p6rv-4g7w": ["[7.0.0, 8.0.4)"], "GHSA-8g4q-xg66-9fp4": ["[8.0.0, 8.0.4]"] },
    "azure.identity": { "GHSA-5mfx-4wcx-rv27": ["(, 1.10.2)"], "GHSA-m5vv-6r4h-3vj9": ["(, 1.11.4)"] },
};

function ranges(packageId: string, url: string): string[] | undefined {
    return RANGES[packageId.toLowerCase()]?.[advisoryId(url)];
}

function pkg(value: Partial<PackageInfo> & { id: string; version: string }): PackageInfo {
    return {
        isVulnerable: false,
        isOutdated: false,
        isDeprecated: false,
        projects: [],
        isTransitive: false,
        ...value,
    };
}

function input(overrides: Partial<DashboardInput> = {}): DashboardInput {
    const vulnerable = [
        pkg({
            id: "Newtonsoft.Json", version: "12.0.1", highestPatch: "12.0.3", isVulnerable: true, severity: "High",
            advisoryUrls: [`${GH}GHSA-5crp-9r3c-p9vr`], projects: ["Shop.Api"], directProjects: ["Shop.Api"],
            projectPaths: { "Shop.Api": "/w/src/Shop.Api/Shop.Api.csproj" },
        }),
        pkg({
            id: "System.Text.Json", version: "8.0.0", highestPatch: "8.0.6", isVulnerable: true, severity: "High",
            advisoryUrls: [`${GH}GHSA-hh2w-p6rv-4g7w`, `${GH}GHSA-8g4q-xg66-9fp4`],
            projects: ["Shop.Core", "Shop.Api"], directProjects: ["Shop.Core"], transitiveProjects: ["Shop.Api"],
        }),
        pkg({
            id: "Azure.Identity", version: "1.7.0", isVulnerable: true, isTransitive: true, severity: "High",
            advisoryUrls: [`${GH}GHSA-m5vv-6r4h-3vj9`, `${GH}GHSA-5mfx-4wcx-rv27`],
            advisorySeverities: { [`${GH}GHSA-m5vv-6r4h-3vj9`]: "Moderate", [`${GH}GHSA-5mfx-4wcx-rv27`]: "High" },
            projects: ["Shop.Data"], directProjects: [], transitiveProjects: ["Shop.Data"],
            transitiveOrigins: [{ project: "Shop.Data", broughtBy: "Microsoft.Data.SqlClient", broughtByKind: "package", absentFromGraph: false }],
        }),
    ];
    const outdated = [
        pkg({ id: "Newtonsoft.Json", version: "12.0.1", latestVersion: "13.0.4", highestPatch: "12.0.3", isOutdated: true, projects: ["Shop.Api"], directProjects: ["Shop.Api"] }),
        pkg({ id: "System.Text.Json", version: "8.0.0", latestVersion: "10.0.14", highestPatch: "8.0.6", isOutdated: true, projects: ["Shop.Core"], directProjects: ["Shop.Core"] }),
        pkg({ id: "Moq", version: "4.18.4", latestVersion: "4.21.0", isOutdated: true, projects: ["Shop.Tests"], directProjects: ["Shop.Tests"] }),
    ];
    const deprecated = [
        pkg({
            id: "Microsoft.Azure.ServiceBus", version: "5.2.0", isDeprecated: true, projects: ["Shop.Api"], directProjects: ["Shop.Api"],
            entries: [{
                id: "Microsoft.Azure.ServiceBus", projectName: "Shop.Api", projectPath: "/w/src/Shop.Api/Shop.Api.csproj", framework: "net8.0",
                isTransitive: false, deprecationReasons: ["Legacy"], alternativePackage: "Azure.Messaging.ServiceBus",
            }],
        }),
    ];
    const installed = [
        pkg({ id: "Newtonsoft.Json", version: "12.0.1", projects: ["Shop.Api"], directProjects: ["Shop.Api"] }),
        pkg({ id: "Microsoft.Azure.ServiceBus", version: "5.2.0", projects: ["Shop.Api"], directProjects: ["Shop.Api"] }),
        pkg({ id: "System.Text.Json", version: "8.0.0", projects: ["Shop.Core"], directProjects: ["Shop.Core"] }),
        pkg({ id: "Microsoft.Data.SqlClient", version: "5.1.0", projects: ["Shop.Data"], directProjects: ["Shop.Data"] }),
        pkg({ id: "Moq", version: "4.18.4", projects: ["Shop.Tests"], directProjects: ["Shop.Tests"] }),
    ];
    return {
        vulnerable,
        outdated,
        deprecated,
        installed,
        scannedAt: new Date("2026-11-04T20:58:00Z"),
        cpm: true,
        centralFiles: ["Directory.Packages.props"],
        feeds: {
            sources: [{ name: "nuget.org", url: "https://api.nuget.org/v3/index.json", enabled: true }],
            failures: [],
            unmatched: [],
            statuses: [{ name: "nuget.org", url: "https://api.nuget.org/v3/index.json", enabled: true, failures: [], hints: [] }],
            credentialProviders: [],
        },
        online: false,
        advisorySource: "local",
        conflicts: 0,
        ignored: 0,
        auditDataGap: false,
        unreadableProjects: [],
        verdict: (packageId, url, version) => {
            const list = ranges(packageId, url);
            if (!list) {
                return "unknown";
            }
            return list.some((range) => versionInsideRange(version, range)) ? "open" : "closed";
        },
        firstFixed: (packageId, url, current) => {
            const list = ranges(packageId, url);
            return list ? firstFixedFromRanges(list, current) : undefined;
        },
        ...overrides,
    };
}

suite("Dashboard state", () => {
    test("advisory ids come from the GHSA url", () => {
        assert.strictEqual(advisoryId(`${GH}GHSA-5crp-9r3c-p9vr`), "GHSA-5crp-9r3c-p9vr");
        assert.strictEqual(advisoryId("https://example.com/advisory/CVE-2024-1?x=1"), "CVE-2024-1");
    });

    test("packages are merged by id and sorted by severity", () => {
        const state = buildDashboardState(input());
        assert.deepStrictEqual(state.packages.map((p) => p.id), [
            "System.Text.Json",
            "Azure.Identity",
            "Newtonsoft.Json",
            "Microsoft.Azure.ServiceBus",
            "Moq",
        ]);
        const stj = state.packages.find((p) => p.id === "System.Text.Json")!;
        assert.strictEqual(stj.kind, "direct");
        assert.deepStrictEqual(stj.directIn, ["Shop.Core"]);
        assert.deepStrictEqual(stj.transitiveIn, ["Shop.Api"]);
        assert.strictEqual(stj.outdated, true);
        assert.strictEqual(stj.latest, "10.0.14");
        assert.strictEqual(state.advisoryCount, 5);
    });

    test("the highest patch is suggested when it closes every advisory", () => {
        const stj = buildDashboardState(input()).packages.find((p) => p.id === "System.Text.Json")!;
        assert.strictEqual(stj.suggested, "8.0.6");
        assert.strictEqual(stj.change, "patch");
        assert.ok(stj.advisories.every((a) => a.verdict === "closed"));
        assert.strictEqual(stj.note?.tone, "ok");
    });

    test("a major is suggested when no patch closes the advisory", () => {
        const nj = buildDashboardState(input()).packages.find((p) => p.id === "Newtonsoft.Json")!;
        assert.strictEqual(nj.suggested, "13.0.1");
        assert.strictEqual(nj.change, "major");
        assert.strictEqual(nj.note?.tone, "warn");
        assert.match(nj.note!.text, /12\.0\.3, does not/);
    });

    test("transitive packages get a pin version, the parent and the why path", () => {
        const identity = buildDashboardState(input()).packages.find((p) => p.id === "Azure.Identity")!;
        assert.strictEqual(identity.kind, "transitive");
        assert.strictEqual(identity.suggested, "1.11.4");
        assert.deepStrictEqual(identity.parents, ["Microsoft.Data.SqlClient"]);
        assert.deepStrictEqual(identity.why, [[
            { name: "Shop.Data", kind: "project" },
            { name: "Microsoft.Data.SqlClient", kind: "package" },
            { name: "Azure.Identity", version: "1.7.0", kind: "package" },
        ]]);
        assert.deepStrictEqual(identity.advisories.map((a) => a.severity), ["high", "moderate"]);
        assert.strictEqual(identity.severity, "high");
    });

    test("deprecated packages with an alternative become a replacement", () => {
        const sb = buildDashboardState(input()).packages.find((p) => p.id === "Microsoft.Azure.ServiceBus")!;
        assert.strictEqual(sb.change, "replace");
        assert.strictEqual(sb.deprecated, "Legacy");
        assert.strictEqual(sb.alternative, "Azure.Messaging.ServiceBus");
        assert.strictEqual(sb.severity, "none");
    });

    test("the score follows the formula", () => {
        const state = buildDashboardState(input());
        // 3 high vulnerable packages, 3 outdated direct, 1 deprecated direct.
        assert.strictEqual(state.score.vulnerable, 24);
        assert.strictEqual(state.score.outdated, 6);
        assert.strictEqual(state.score.deprecated, 4);
        assert.strictEqual(state.score.feeds, 0);
        assert.strictEqual(state.score.score, 66);
    });

    test("recommended actions: patch first, then major, pin, replace and minor", () => {
        const state = buildDashboardState(input());
        assert.deepStrictEqual(state.actions.map((a) => a.id), [
            "patch",
            "update:Newtonsoft.Json",
            "pin:Azure.Identity",
            "replace:Microsoft.Azure.ServiceBus",
            "minor",
        ]);
        const patch = findAction(state, "patch")!;
        assert.deepStrictEqual(patch.updates.map((u) => `${u.packageId} ${u.from}->${u.to}`), [
            "System.Text.Json 8.0.0->8.0.6",
            "Newtonsoft.Json 12.0.1->12.0.3",
        ]);
        assert.strictEqual(patch.closes, 2);
        assert.deepStrictEqual(patch.files, ["Directory.Packages.props"]);
        // System.Text.Json stays vulnerable in Shop.Api, which the patch does not edit.
        assert.strictEqual(patch.score, undefined);
        assert.ok(patch.preview.lines.some((line) => /Newtonsoft\.Json 12\.0\.1 → 12\.0\.3 · 1 stays open/.test(line)));

        const major = findAction(state, "update:Newtonsoft.Json")!;
        assert.strictEqual(major.badge, "major");
        assert.strictEqual(major.closes, 1);
        assert.strictEqual(major.preview.heading, "Newtonsoft.Json 12.0.1 → 13.0.1");
        assert.ok(major.preview.lines.includes("Closes GHSA-5crp-9r3c-p9vr."));

        const pin = findAction(state, "pin:Azure.Identity")!;
        assert.strictEqual(pin.closes, 2);
        assert.match(pin.description, /Microsoft\.Data\.SqlClient/);

        assert.strictEqual(findAction(state, "replace:Microsoft.Azure.ServiceBus")!.warning, "Code changes needed");
        assert.strictEqual(findAction(state, "missing"), undefined);
        assert.strictEqual(findAction(undefined, "patch"), undefined);
    });

    test("projects count what they hold", () => {
        const projects = buildDashboardState(input()).projects;
        assert.deepStrictEqual(projects.map((p) => p.name), ["Shop.Api", "Shop.Core", "Shop.Data", "Shop.Tests"]);
        const api = projects[0];
        assert.deepStrictEqual({ direct: api.direct, vulnerable: api.vulnerable, outdated: api.outdated, deprecated: api.deprecated },
            { direct: 2, vulnerable: 2, outdated: 1, deprecated: 1 });
    });

    test("without project files under CPM, the edited files are the project files", () => {
        const state = buildDashboardState(input({ cpm: false, centralFiles: [], relativePath: (p) => p.replace("/w/", "") }));
        assert.deepStrictEqual(findAction(state, "update:Newtonsoft.Json")!.files, ["src/Shop.Api/Shop.Api.csproj"]);
    });

    test("feed failures count as issues and lower the score", () => {
        const state = buildDashboardState(input({
            feeds: {
                sources: [{ name: "corp", url: "https://corp/v3/index.json", enabled: true }],
                failures: [],
                unmatched: [],
                statuses: [{ name: "corp", url: "https://corp/v3/index.json", enabled: true, failures: [{ code: "NU1301", message: "401", at: 1 }], hints: ["Sign in"] }],
                credentialProviders: ["CredentialProvider.Microsoft"],
            },
        }));
        assert.strictEqual(state.feeds.issues, 1);
        assert.strictEqual(state.score.feeds, 4);
        assert.deepStrictEqual(state.feeds.items[0].failures, [{ code: "NU1301", message: "401" }]);
    });

    test("without advisory data there is no suggested fix and a note says why", () => {
        const state = buildDashboardState(input({ advisorySource: undefined, verdict: () => "unknown", firstFixed: () => undefined }));
        const identity = state.packages.find((p) => p.id === "Azure.Identity")!;
        assert.strictEqual(identity.suggested, undefined);
        assert.match(identity.note!.text, /No advisory ranges are loaded/);
        assert.ok(!state.actions.some((a) => a.kind === "pin"));
    });

    test("an empty workspace", () => {
        const state = buildDashboardState(input({ vulnerable: [], outdated: [], deprecated: [], installed: [], scannedAt: undefined }));
        assert.strictEqual(state.hasScan, false);
        assert.strictEqual(state.score.score, 100);
        assert.deepStrictEqual(state.actions, []);
        assert.deepStrictEqual(state.projects, []);
    });

    test("notices for an audit gap and unreadable projects", () => {
        const state = buildDashboardState(input({ auditDataGap: true, unreadableProjects: ["Legacy.vbproj"] }));
        assert.strictEqual(state.notices.length, 2);
        assert.match(state.notices[1], /Legacy\.vbproj/);
    });

    test("an update is scoped to older occurrences and never downgrades a newer one", () => {
        const base = input();
        const nj = base.vulnerable[0];
        // Only Shop.Api is vulnerable; Shop.Worker already has 13.0.4.
        base.installed[0] = pkg({
            id: "Newtonsoft.Json", version: "12.0.1", projects: ["Shop.Api", "Shop.Worker"], directProjects: ["Shop.Api", "Shop.Worker"],
            versionByProject: { "Shop.Api": "12.0.1", "Shop.Worker": "13.0.4" },
        });
        nj.versionByProject = { "Shop.Api": "12.0.1" };
        const state = buildDashboardState(base);
        const package_ = state.packages.find((p) => p.id === "Newtonsoft.Json")!;
        assert.strictEqual(package_.suggested, "13.0.1");
        assert.deepStrictEqual(package_.updateIn, [{ name: "Shop.Api", from: "12.0.1", relation: "direct" }]);
        assert.deepStrictEqual(findAction(state, "update:Newtonsoft.Json")!.projects, ["Shop.Api"]);
    });

    test("occurrences already at the suggested version or newer are not targeted", () => {
        const base = input();
        base.vulnerable[1].versionByProject = { "Shop.Core": "8.0.0", "Shop.Api": "8.0.6" };
        const stj = buildDashboardState(base).packages.find((p) => p.id === "System.Text.Json")!;
        assert.deepStrictEqual(stj.updateIn.map((t) => t.name), ["Shop.Core"]);
    });

    test("a stale transitive warning gets no suggested pin", () => {
        const base = input();
        base.vulnerable[2].transitiveOrigins = [{ project: "Shop.Data", absentFromGraph: true }];
        const state = buildDashboardState(base);
        const identity = state.packages.find((p) => p.id === "Azure.Identity")!;
        assert.strictEqual(identity.suggested, undefined);
        assert.deepStrictEqual(identity.updateIn, []);
        assert.match(identity.note!.text, /not in the resolved package graph/);
        assert.strictEqual(findAction(state, "pin:Azure.Identity"), undefined);
        // It is still a known vulnerability for the score.
        assert.strictEqual(identity.vulnerable, true);
        assert.strictEqual(state.score.vulnerable, 24);
    });

    test("a direct package does not pin into projects whose transitive warning is stale", () => {
        const base = input();
        base.vulnerable[1].transitiveOrigins = [{ project: "Shop.Api", absentFromGraph: true }];
        const stj = buildDashboardState(base).packages.find((p) => p.id === "System.Text.Json")!;
        assert.strictEqual(stj.suggested, "8.0.6");
        assert.deepStrictEqual(stj.updateIn.map((t) => t.name), ["Shop.Core"]);
    });

    test("heatmap counts come from each project's own report", () => {
        const base = input();
        // Newtonsoft.Json is vulnerable only in Shop.Api but outdated in Shop.Worker too.
        base.outdated[0] = pkg({
            id: "Newtonsoft.Json", version: "12.0.1", latestVersion: "13.0.4", highestPatch: "12.0.3", isOutdated: true,
            projects: ["Shop.Api", "Shop.Worker"], directProjects: ["Shop.Api", "Shop.Worker"],
        });
        base.installed.push(pkg({ id: "Newtonsoft.Json", version: "12.0.1", projects: ["Shop.Worker"], directProjects: ["Shop.Worker"] }));
        const projects = buildDashboardState(base).projects;
        const worker = projects.find((p) => p.name === "Shop.Worker")!;
        assert.deepStrictEqual({ vulnerable: worker.vulnerable, outdated: worker.outdated, deprecated: worker.deprecated },
            { vulnerable: 0, outdated: 1, deprecated: 0 });
        const api = projects.find((p) => p.name === "Shop.Api")!;
        assert.deepStrictEqual({ vulnerable: api.vulnerable, outdated: api.outdated, deprecated: api.deprecated },
            { vulnerable: 2, outdated: 1, deprecated: 1 });
    });

    test("a deprecated package is counted only where the deprecated report saw it", () => {
        const base = input();
        base.outdated.push(pkg({
            id: "Microsoft.Azure.ServiceBus", version: "5.2.0", latestVersion: "5.2.1", isOutdated: true,
            projects: ["Shop.Tests"], directProjects: ["Shop.Tests"],
        }));
        const tests = buildDashboardState(base).projects.find((p) => p.name === "Shop.Tests")!;
        assert.strictEqual(tests.deprecated, 0);
        assert.strictEqual(tests.outdated, 2);
    });

    test("vulnerable packages without an advisory link still count", () => {
        const base = input({ vulnerable: [pkg({
            id: "Legacy.Crypto", version: "1.0.0", isVulnerable: true, severity: "High", projects: ["Shop.Api"], directProjects: ["Shop.Api"],
        })], outdated: [], deprecated: [] });
        const state = buildDashboardState(base);
        const legacy = state.packages.find((p) => p.id === "Legacy.Crypto")!;
        assert.strictEqual(legacy.vulnerable, true);
        assert.deepStrictEqual(legacy.advisories, []);
        assert.strictEqual(legacy.severity, "high");
        assert.match(legacy.note!.text, /no advisory link/);
        assert.strictEqual(state.score.vulnerable, 8);
        assert.strictEqual(state.score.score, 92);
        assert.strictEqual(state.projects.find((p) => p.name === "Shop.Api")!.vulnerable, 1);
    });

    test("preview lists transitive projects of a direct package and the pin they get", () => {
        const base = input();
        base.vulnerable[0] = pkg({
            ...base.vulnerable[0],
            projects: ["Shop.Api", "Shop.Worker"], directProjects: ["Shop.Api"], transitiveProjects: ["Shop.Worker"],
            transitiveOrigins: [{ project: "Shop.Worker", broughtBy: "Shop.Api", broughtByKind: "project", absentFromGraph: false }],
        });
        const state = buildDashboardState(base);
        const action = findAction(state, "update:Newtonsoft.Json")!;
        assert.deepStrictEqual(action.projects, ["Shop.Api", "Shop.Worker"]);
        assert.ok(action.preview.lines.includes("Direct reference in: Shop.Api."));
        assert.ok(action.preview.lines.some((line) => /^Transitive in: Shop\.Worker\. A direct PackageReference will be added/.test(line)));
    });

    test("the patch estimate keeps advisories the patch leaves open, at their own severity", () => {
        const advisoryHigh = `${GH}GHSA-aaaa-bbbb-cccc`;
        const advisoryLow = `${GH}GHSA-dddd-eeee-ffff`;
        RANGES["contoso.lib"] = { "GHSA-aaaa-bbbb-cccc": ["(, 2.0.1)"], "GHSA-dddd-eeee-ffff": ["(, 3.0.0)"] };
        try {
            const base = input({
                vulnerable: [pkg({
                    id: "Contoso.Lib", version: "2.0.0", highestPatch: "2.0.5", isVulnerable: true, severity: "High",
                    advisoryUrls: [advisoryHigh, advisoryLow],
                    advisorySeverities: { [advisoryHigh]: "High", [advisoryLow]: "Low" },
                    projects: ["Shop.Api"], directProjects: ["Shop.Api"],
                })],
                outdated: [],
                deprecated: [],
            });
            const state = buildDashboardState(base);
            assert.strictEqual(state.score.score, 92);
            // 2.0.5 closes the high advisory; the low one stays: 100 - 1.
            assert.deepStrictEqual(findAction(state, "patch")!.score, { from: 92, to: 99 });
        } finally {
            delete RANGES["contoso.lib"];
        }
    });

    test("the patch estimate keeps transitive occurrences the bulk patch does not touch", () => {
        // System.Text.Json is direct in Shop.Core and transitive in Shop.Api.
        // The highest patch only edits Shop.Core, so Shop.Api stays vulnerable.
        const state = buildDashboardState(input());
        const patch = findAction(state, "patch")!;
        // Nothing leaves the score: 12.0.3 does not close the Newtonsoft.Json advisory, and
        // both patched packages are still behind the latest version.
        assert.strictEqual(patch.score, undefined);
        const base = input();
        base.vulnerable[1] = pkg({ ...base.vulnerable[1], projects: ["Shop.Core"], transitiveProjects: [] });
        const direct = findAction(buildDashboardState(base), "patch")!;
        // Now the patch clears System.Text.Json: 2 high (16), 3 outdated (6), 1 deprecated (4) = 74.
        assert.deepStrictEqual(direct.score, { from: 66, to: 74 });
    });

    test("the state survives JSON, as postMessage needs", () => {
        const state = buildDashboardState(input());
        const json = JSON.stringify(state);
        assert.strictEqual(state.scannedAt, "2026-11-04T20:58:00.000Z");
        assert.strictEqual(JSON.stringify(JSON.parse(json)), json);
    });
});
