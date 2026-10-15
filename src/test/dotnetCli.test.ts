import * as assert from "assert";
import { DotnetCli } from "../services/DotnetCli";

suite("DotnetCli JSON", () => {
    const cli = new DotnetCli();

    test("empty output is an empty list", () => {
        assert.deepStrictEqual(cli.parsePackageList("", "vulnerable"), []);
    });

    test("broken JSON is an empty list", () => {
        assert.deepStrictEqual(cli.parsePackageList("{", "vulnerable"), []);
    });

    test("reads a direct vulnerable package", () => {
        const packages = cli.parsePackageList(JSON.stringify({
            projects: [{
                path: "samples/audit-quickfix/AuditQuickFix.csproj",
                frameworks: [{
                    topLevelPackages: [{
                        id: "Newtonsoft.Json",
                        requestedVersion: "12.0.1",
                        resolvedVersion: "12.0.1",
                        vulnerabilities: [{
                            severity: "High",
                            advisoryurl: "https://github.com/advisories/GHSA-5crp-9r3c-p9vr",
                        }],
                    }],
                }],
            }],
        }), "vulnerable");

        assert.strictEqual(packages.length, 1);
        assert.strictEqual(packages[0].id, "Newtonsoft.Json");
        assert.strictEqual(packages[0].version, "12.0.1");
        assert.strictEqual(packages[0].severity, "High");
        assert.strictEqual(packages[0].advisoryUrl, "https://github.com/advisories/GHSA-5crp-9r3c-p9vr");
        assert.strictEqual(packages[0].isVulnerable, true);
        assert.strictEqual(packages[0].isOutdated, false);
        assert.strictEqual(packages[0].isTransitive, false);
        assert.deepStrictEqual(packages[0].projects, ["AuditQuickFix"]);
        assert.deepStrictEqual(packages[0].transitiveProjects, []);
    });

    test("a direct sighting keeps the package direct", () => {
        const packages = cli.parsePackageList(JSON.stringify({
            projects: [
                {
                    path: "AuditQuickFix.csproj",
                    frameworks: [{
                        topLevelPackages: [{
                            id: "Newtonsoft.Json",
                            resolvedVersion: "12.0.1",
                            vulnerabilities: [{ severity: "High", advisoryurl: "https://example.test/high" }],
                        }],
                    }],
                },
                {
                    path: "Consumer/Consumer.csproj",
                    frameworks: [{
                        transitivePackages: [{
                            id: "Newtonsoft.Json",
                            resolvedVersion: "12.0.1",
                            vulnerabilities: [{ severity: "Moderate", advisoryurl: "https://example.test/moderate" }],
                        }],
                    }],
                },
            ],
        }), "vulnerable");

        assert.strictEqual(packages.length, 1);
        assert.strictEqual(packages[0].isTransitive, false);
        assert.deepStrictEqual(packages[0].projects, ["AuditQuickFix", "Consumer"]);
        assert.deepStrictEqual(packages[0].transitiveProjects, ["Consumer"]);
        assert.strictEqual(packages[0].severity, "High");
    });

    test("critical replaces a lower severity", () => {
        const packages = cli.parsePackageList(JSON.stringify({
            projects: [{
                path: "Api.csproj",
                frameworks: [{
                    topLevelPackages: [{
                        id: "Contoso.Lib",
                        resolvedVersion: "1.0.0",
                        vulnerabilities: [
                            { severity: "Low", advisoryurl: "https://example.test/low" },
                            { severity: "Critical", advisoryurl: "https://example.test/critical" },
                        ],
                    }],
                }],
            }],
        }), "vulnerable");

        assert.strictEqual(packages[0].severity, "Critical");
        assert.strictEqual(packages[0].advisoryUrl, "https://example.test/critical");
    });

    test("outdated list keeps latest and skips a package without a version", () => {
        const packages = cli.parsePackageList(JSON.stringify({
            projects: [{
                path: "AuditQuickFix.csproj",
                frameworks: [{
                    topLevelPackages: [
                        { id: "Newtonsoft.Json", resolvedVersion: "12.0.1", latestVersion: "13.0.4" },
                        { id: "Missing.Version" },
                    ],
                }],
            }],
        }), "outdated");

        assert.strictEqual(packages.length, 1);
        assert.strictEqual(packages[0].version, "12.0.1");
        assert.strictEqual(packages[0].latestVersion, "13.0.4");
        assert.strictEqual(packages[0].isOutdated, true);
        assert.strictEqual(packages[0].isVulnerable, false);
    });

    test("deprecated list marks only deprecated", () => {
        const packages = cli.parsePackageList(JSON.stringify({
            projects: [{
                path: "Old.csproj",
                frameworks: [{
                    topLevelPackages: [{ id: "Legacy.Pack", version: "1.2.3" }],
                }],
            }],
        }), "deprecated");

        assert.strictEqual(packages[0].isDeprecated, true);
        assert.strictEqual(packages[0].isVulnerable, false);
        assert.strictEqual(packages[0].isOutdated, false);
    });

    test("an fsproj name is read without the extension", () => {
        const packages = cli.parsePackageList(JSON.stringify({
            projects: [{
                path: "src/Library.fsproj",
                frameworks: [{
                    topLevelPackages: [{ id: "Newtonsoft.Json", resolvedVersion: "13.0.3" }],
                }],
            }],
        }), "vulnerable");

        assert.deepStrictEqual(packages[0].projects, ["Library"]);
    });

    test("the installed list keeps direct packages and every project name", () => {
        const json = JSON.stringify({
            projects: [
                {
                    path: "Api.fsproj",
                    frameworks: [{ topLevelPackages: [] }],
                },
                {
                    path: "Web.csproj",
                    frameworks: [{
                        topLevelPackages: [{ id: "Serilog", resolvedVersion: "4.0.0" }],
                        transitivePackages: [{ id: "System.Text.Json", resolvedVersion: "8.0.0" }],
                    }],
                },
            ],
        });

        const packages = cli.parsePackageList(json, "installed");
        assert.strictEqual(packages.length, 1);
        assert.strictEqual(packages[0].id, "Serilog");
        assert.strictEqual(packages[0].isVulnerable, false);
        assert.strictEqual(packages[0].isOutdated, false);
        assert.strictEqual(packages[0].isDeprecated, false);
        assert.strictEqual(packages[0].isTransitive, false);
        assert.deepStrictEqual(cli.parseListedProjects(json), ["Api", "Web"]);
    });

    test("a project with no packages is still named", () => {
        const names = cli.parseListedProjects(JSON.stringify({
            projects: [{
                path: "Clean.csproj",
                frameworks: [{ topLevelPackages: [] }],
            }],
        }));

        assert.deepStrictEqual(names, ["Clean"]);
    });
});
