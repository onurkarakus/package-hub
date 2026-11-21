import * as assert from "assert";
import { PackageEntry } from "../models/PackageInfo";
import { alignablePackages, planAlignment } from "../services/Consolidate";

function entry(projectName: string, version: string, extra: Partial<PackageEntry> = {}): PackageEntry {
    return {
        id: "Serilog",
        projectName,
        projectPath: `/w/${projectName}/${projectName}.csproj`,
        framework: "net8.0",
        requestedVersion: version,
        resolvedVersion: version,
        isTransitive: false,
        ...extra,
    };
}

suite("Align versions", () => {
    test("moves drifted projects to the highest version in the same major", () => {
        const plans = planAlignment("Serilog", [entry("Api", "3.1.1"), entry("Worker", "3.0.0"), entry("Tests", "3.1.1")]);
        assert.strictEqual(plans.length, 1);
        assert.strictEqual(plans[0].target, "3.1.1");
        assert.deepStrictEqual(plans[0].moves.map((move) => [move.projectName, move.from]), [["Worker", "3.0.0"]]);
        assert.deepStrictEqual(plans[0].aligned, ["Api", "Tests"]);
    });

    test("never crosses a major version", () => {
        const plans = planAlignment("Serilog", [entry("A", "2.10.0"), entry("B", "2.12.0"), entry("C", "3.0.0"), entry("D", "3.1.0")]);
        assert.deepStrictEqual(plans.map((plan) => [plan.major, plan.target]), [[3, "3.1.0"], [2, "2.12.0"]]);
    });

    test("keeps per-framework splits, ranges and transitive references", () => {
        const entries = [
            entry("Lib", "3.0.0", { framework: "net8.0" }),
            entry("Lib", "2.12.0", { framework: "netstandard2.0" }),
            entry("Ranged", "3.0.0", { requestedVersion: "[3.0.0, 4.0.0)" }),
            entry("Api", "3.1.0"),
            entry("Worker", "3.0.5"),
            entry("Transitive", "3.0.0", { isTransitive: true }),
        ];
        const plans = planAlignment("Serilog", entries);
        assert.strictEqual(plans.length, 1);
        assert.deepStrictEqual(plans[0].moves.map((move) => move.projectName), ["Worker"]);
        assert.deepStrictEqual(plans[0].kept.map((kept) => kept.projectName).sort(), ["Lib", "Ranged"]);
    });

    test("lists only packages that have something to align", () => {
        const entries = [
            entry("Api", "3.1.0"),
            entry("Worker", "3.0.0"),
            { ...entry("Api", "13.0.3"), id: "Newtonsoft.Json" },
            { ...entry("Worker", "13.0.3"), id: "Newtonsoft.Json" },
        ];
        assert.deepStrictEqual(alignablePackages(entries), ["Serilog"]);
        assert.deepStrictEqual(planAlignment("Newtonsoft.Json", entries), []);
    });
});
