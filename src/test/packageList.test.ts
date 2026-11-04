import * as assert from "assert";
import * as path from "path";
import { aggregatePackages, extractJson, findVersionConflicts, parsePackageListJson, TargetUnreadableError } from "../services/PackageList";

const root = path.resolve("/repo");
const api = path.join(root, "Api", "Api.csproj");
const worker = path.join(root, "Worker", "Worker.csproj");

function report(projects: unknown[], problems?: unknown[]): string {
    return JSON.stringify({ version: 1, parameters: "", problems, projects });
}

function project(file: string, frameworks: unknown[]): unknown {
    return { path: file, frameworks };
}

suite("dotnet list package JSON", () => {
    test("empty or broken output is not a healthy result", () => {
        assert.throws(() => parsePackageListJson("", "vulnerable"), TargetUnreadableError);
        assert.throws(() => parsePackageListJson("{ not json", "vulnerable"), TargetUnreadableError);
        assert.throws(() => parsePackageListJson("error: MSBUILD : error MSB1009: Project file does not exist.", "outdated"), TargetUnreadableError);
    });

    test("an error problem without a project makes the target unreadable", () => {
        assert.throws(
            () => parsePackageListJson(report([], [{ level: "error", text: "Restore failed." }]), "vulnerable"),
            (error: unknown) => error instanceof TargetUnreadableError && error.problems.length === 1
        );
    });

    test("an error problem for one project marks only that project", () => {
        const result = parsePackageListJson(report(
            [
                project(api, [{ framework: "net8.0", topLevelPackages: [{ id: "A", requestedVersion: "1.0.0", resolvedVersion: "1.0.0" }] }]),
                project(worker, []),
            ],
            [
                { level: "error", project: worker, text: "No assets file was found." },
                { level: "warning", project: api, text: "Just a warning." },
            ]
        ), "installed");
        assert.deepStrictEqual(result.unreadableProjects, ["Worker"]);
        assert.deepStrictEqual(result.projects, ["Api"]);
        assert.strictEqual(result.problems.length, 2);
        assert.strictEqual(result.entries.length, 1);
    });

    test("JSON is found after restore noise", () => {
        const noisy = `  Determining projects to restore...\n${report([])}\n`;
        assert.ok(extractJson(noisy)?.startsWith("{"));
        assert.deepStrictEqual(parsePackageListJson(noisy, "vulnerable").projects, []);
    });

    test("entries keep project, framework, requested and resolved versions", () => {
        const result = parsePackageListJson(report([
            project(api, [
                {
                    framework: "net8.0",
                    topLevelPackages: [{
                        id: "Newtonsoft.Json",
                        requestedVersion: "[12.0.1, )",
                        resolvedVersion: "12.0.1",
                        vulnerabilities: [{ severity: "High", advisoryurl: "https://github.com/advisories/GHSA-5crp-9r3c-p9vr" }],
                    }],
                    transitivePackages: [{ id: "System.Text.Json", resolvedVersion: "6.0.0" }],
                },
                {
                    framework: "net6.0",
                    topLevelPackages: [{ id: "Newtonsoft.Json", requestedVersion: "[12.0.1, )", resolvedVersion: "12.0.1" }],
                },
            ]),
        ]), "vulnerable");
        const direct = result.entries.filter((entry) => !entry.isTransitive);
        assert.deepStrictEqual(direct.map((entry) => entry.framework).sort(), ["net6.0", "net8.0"]);
        assert.strictEqual(direct[0].requestedVersion, "[12.0.1, )");
        assert.strictEqual(direct[0].resolvedVersion, "12.0.1");
        const [pkg] = result.packages.filter((item) => item.id === "Newtonsoft.Json");
        assert.strictEqual(pkg.version, "12.0.1");
        assert.strictEqual(pkg.severity, "High");
        assert.deepStrictEqual(pkg.directProjects, ["Api"]);
        assert.ok(pkg.advisoryUrls?.includes("https://github.com/advisories/GHSA-5crp-9r3c-p9vr"));
    });

    test("aggregation keeps the version per project and splits direct from transitive", () => {
        const result = parsePackageListJson(report([
            project(api, [{ framework: "net8.0", topLevelPackages: [{ id: "Serilog", requestedVersion: "3.0.0", resolvedVersion: "3.0.0" }] }]),
            project(worker, [{ framework: "net8.0", transitivePackages: [{ id: "Serilog", resolvedVersion: "2.12.0" }] }]),
        ]), "outdated");
        const [serilog] = aggregatePackages(result.entries, "outdated");
        assert.deepStrictEqual(serilog.versionByProject, { Api: "3.0.0", Worker: "2.12.0" });
        assert.deepStrictEqual(serilog.requestedVersionByProject, { Api: "3.0.0" });
        assert.deepStrictEqual(serilog.directProjects, ["Api"]);
        assert.deepStrictEqual(serilog.transitiveProjects, ["Worker"]);
        assert.strictEqual(serilog.isTransitive, false);

        const installed = parsePackageListJson(report([
            project(worker, [{ framework: "net8.0", transitivePackages: [{ id: "Serilog", resolvedVersion: "2.12.0" }] }]),
        ]), "installed");
        assert.deepStrictEqual(installed.entries, [], "installed lists direct references only");
    });

    test("version conflicts across projects and frameworks", () => {
        const result = parsePackageListJson(report([
            project(api, [
                { framework: "net8.0", topLevelPackages: [{ id: "Polly", requestedVersion: "8.0.0", resolvedVersion: "8.0.0" }] },
                { framework: "net6.0", topLevelPackages: [{ id: "Polly", requestedVersion: "7.2.4", resolvedVersion: "7.2.4" }] },
            ]),
            project(worker, [{ framework: "net8.0", topLevelPackages: [
                { id: "Polly", requestedVersion: "8.0.0", resolvedVersion: "8.0.0" },
                { id: "Same", requestedVersion: "1.0", resolvedVersion: "1.0.0" },
            ] }]),
            project(path.join(root, "Other", "Other.csproj"), [{ framework: "net8.0", topLevelPackages: [{ id: "Same", requestedVersion: "1.0.0", resolvedVersion: "1.0.0" }] }]),
        ]), "installed");
        const conflicts = findVersionConflicts(result.entries);
        assert.deepStrictEqual(conflicts, [{
            id: "Polly",
            versions: [
                { version: "7.2.4", projects: ["Api (net6.0)"] },
                { version: "8.0.0", projects: ["Api (net8.0)", "Worker"] },
            ],
        }]);
    });
});
