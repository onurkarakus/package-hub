import * as assert from "assert";
import {
    chooseQuickFixVersions,
    compareNuGetVersions,
    highestPatchFrom,
    isComparableVersion,
    isNewerVersion,
    isPrereleaseVersion,
    isSafeChannelTarget,
    isValidPackageId,
    isValidPackageVersion,
    normalizeSeverity,
    parseNuGetVersion,
    sameNuGetVersion,
    severityRank,
    versionChange,
    versionInsideRange,
} from "../utils/nugetAudit";

suite("NuGet versions", () => {
    const sign = (value: number) => (Number.isNaN(value) ? "NaN" : value < 0 ? "<" : value > 0 ? ">" : "=");

    // [left, right, expected]
    const table: [string, string, string][] = [
        ["1.0.0", "1.0.0", "="],
        ["1.0", "1.0.0", "="],
        ["1", "1.0.0.0", "="],
        ["1.0.0.0", "1.0.0", "="],
        ["1.0.0.1", "1.0.0", ">"],
        ["1.0.0.1", "1.0.1", "<"],
        ["1.2.3", "1.2.10", "<"],
        ["1.10.0", "1.9.0", ">"],
        ["2.0.0", "10.0.0", "<"],
        ["1.0.0-alpha", "1.0.0", "<"],
        ["1.0.0", "1.0.0-rc.1", ">"],
        ["1.0.0-alpha", "1.0.0-beta", "<"],
        ["1.0.0-ALPHA", "1.0.0-alpha", "="],
        ["1.0.0-Beta", "1.0.0-alpha", ">"],
        ["1.0.0-rc.2", "1.0.0-rc.10", "<"],
        ["1.0.0-rc.10", "1.0.0-rc.9", ">"],
        ["1.0.0-1", "1.0.0-alpha", "<"],
        ["1.0.0-alpha", "1.0.0-alpha.1", "<"],
        ["1.0.0-alpha.1", "1.0.0-alpha.beta", "<"],
        ["1.0.0-alpha.beta", "1.0.0-beta", "<"],
        ["1.0.0-beta.2", "1.0.0-beta.11", "<"],
        ["1.0.0-beta.11", "1.0.0-rc.1", "<"],
        ["1.0.0+build.1", "1.0.0+build.2", "="],
        ["1.0.0+abc", "1.0.0", "="],
        ["1.0.0-rc.1+build.5", "1.0.0-rc.1", "="],
        ["13.0.4", "12.0.3", ">"],
        ["8.0.0-preview.7.23375.6", "8.0.0-rc.1.23419.4", "<"],
        ["1.0.0-alpha-1", "1.0.0-alpha-2", "<"],
        ["[1.0.0, 2.0.0)", "1.0.0", "NaN"],
        ["[1.0.0]", "1.0.0", "NaN"],
        ["1.*", "1.0.0", "NaN"],
        ["$(NewtonsoftVersion)", "1.0.0", "NaN"],
        ["", "1.0.0", "NaN"],
        ["1.0.0.0.0", "1.0.0", "NaN"],
        ["v1.0.0", "1.0.0", "NaN"],
        ["1.0.0-", "1.0.0", "NaN"],
        ["1.0.0-rc..1", "1.0.0", "NaN"],
    ];

    for (const [left, right, expected] of table) {
        test(`${left || "(empty)"} ${expected} ${right}`, () => {
            assert.strictEqual(sign(compareNuGetVersions(left, right)), expected);
            if (expected !== "NaN") {
                const reverse = expected === "<" ? ">" : expected === ">" ? "<" : "=";
                assert.strictEqual(sign(compareNuGetVersions(right, left)), reverse);
            }
        });
    }

    test("sorting uses NuGet order", () => {
        const sorted = ["1.0.0", "1.0.0-rc.1", "1.0.0-alpha", "0.9.9", "1.0.0-rc.10", "1.0.0-rc.2", "1.0.0.1"]
            .sort((a, b) => compareNuGetVersions(a, b));
        assert.deepStrictEqual(sorted, ["0.9.9", "1.0.0-alpha", "1.0.0-rc.1", "1.0.0-rc.2", "1.0.0-rc.10", "1.0.0", "1.0.0.1"]);
    });

    test("parse keeps four parts and the prerelease labels", () => {
        assert.deepStrictEqual(parseNuGetVersion("1.2"), { release: [1, 2, 0, 0], prerelease: [] });
        assert.deepStrictEqual(parseNuGetVersion(" 1.2.3.4-rc.1+meta "), { release: [1, 2, 3, 4], prerelease: ["rc", "1"] });
        assert.strictEqual(parseNuGetVersion("(, 13.0.1)"), undefined);
    });

    test("non-comparable values are never the same or newer", () => {
        assert.strictEqual(sameNuGetVersion("[1.0.0]", "1.0.0"), false);
        assert.strictEqual(isNewerVersion("$(V)", "1.0.0"), false);
        assert.strictEqual(isComparableVersion("1.*"), false);
        assert.strictEqual(isComparableVersion("1.0.0-beta"), true);
        assert.strictEqual(isPrereleaseVersion("1.0.0-beta"), true);
        assert.strictEqual(isPrereleaseVersion("1.0.0+beta"), false);
    });

    test("range checks use the same compare", () => {
        assert.strictEqual(versionInsideRange("12.0.3", "(, 13.0.1)"), true);
        assert.strictEqual(versionInsideRange("13.0.1", "(, 13.0.1)"), false);
        assert.strictEqual(versionInsideRange("13.0.1-beta1", "(, 13.0.1)"), true);
        assert.strictEqual(versionInsideRange("1.0.0-rc.10", "[1.0.0-rc.2, 1.0.0)"), true);
        assert.strictEqual(versionInsideRange("$(V)", "(, 13.0.1)"), undefined);
        assert.strictEqual(versionInsideRange("1.0.0", "(, $(Max))"), undefined);
    });

    // [current, candidate, patch, minor]
    const channels: [string | undefined, string | undefined, boolean, boolean][] = [
        ["12.0.1", "12.0.3", true, true],
        ["12.0.1", "12.1.0", false, true],
        ["12.0.1", "13.0.1", false, false],
        ["12.0.1", "12.0.1", false, false],
        ["12.0.3", "12.0.1", false, false],
        ["12.0.1", "12.0.2-beta", false, false],
        ["12.0.1-beta", "12.0.1-rc", false, true],
        ["12.0.1-beta", "12.0.1", true, true],
        ["12.0.1", "12.0.1.1", true, true],
        ["[12.0.1, )", "12.0.3", false, false],
        ["12.0.1", "1.*", false, false],
        [undefined, "12.0.3", false, false],
        ["12.0.1", undefined, false, false],
    ];
    for (const [current, candidate, patch, minor] of channels) {
        test(`safe target ${current} → ${candidate}: patch ${patch}, minor ${minor}`, () => {
            assert.strictEqual(isSafeChannelTarget(current, candidate, "patch"), patch);
            assert.strictEqual(isSafeChannelTarget(current, candidate, "minor"), minor);
        });
    }

    test("version change names the step", () => {
        assert.strictEqual(versionChange("12.0.1", "13.0.4"), "major");
        assert.strictEqual(versionChange("12.0.1", "12.1.0"), "minor");
        assert.strictEqual(versionChange("12.0.1", "12.0.3"), "patch");
        assert.strictEqual(versionChange("12.0.1", "12.0.1.5"), "revision");
        assert.strictEqual(versionChange("12.0.1-beta", "12.0.1"), "prerelease");
        assert.strictEqual(versionChange("12.0.1", "12.0.1"), "same");
        assert.strictEqual(versionChange("12.0.3", "12.0.1"), "downgrade");
        assert.strictEqual(versionChange("[12.0.1]", "12.0.3"), "unknown");
    });

    test("quick fix ignores non-comparable candidates", () => {
        assert.deepStrictEqual(chooseQuickFixVersions("12.0.1", "12.0.3", "13.0.4"), { patch: "12.0.3", latest: "13.0.4" });
        assert.deepStrictEqual(chooseQuickFixVersions("12.0.1", "1.*", "13.0.4"), { patch: undefined, latest: "13.0.4" });
        assert.deepStrictEqual(chooseQuickFixVersions("13.0.4", "12.0.3", "13.0.4"), { patch: undefined, latest: undefined });
    });

    test("highest patch from a version list", () => {
        const versions = ["12.0.1", "12.0.2", "12.0.3", "12.0.4-beta", "12.1.0", "13.0.1"];
        assert.strictEqual(highestPatchFrom("12.0.1", versions), "12.0.3");
        assert.strictEqual(highestPatchFrom("12.0.1", versions, true), "12.0.4-beta");
        assert.strictEqual(highestPatchFrom("12.0.3", versions), undefined);
        assert.strictEqual(highestPatchFrom("$(V)", versions), undefined);
    });

    test("package ids and versions are validated before dotnet runs", () => {
        for (const ok of ["Newtonsoft.Json", "xunit.v3", "My_Package-1"]) {
            assert.strictEqual(isValidPackageId(ok), true, ok);
        }
        for (const bad of ["", "-rf", ".hidden", "a b", "a;b", "a&b", "a|b", "$(x)", "a\"b", "x".repeat(101), 3]) {
            assert.strictEqual(isValidPackageId(bad), false, String(bad));
        }
        for (const ok of ["1.0.0", "1.0.0-rc.1", "1.0.0.1", "1.0.0+meta"]) {
            assert.strictEqual(isValidPackageVersion(ok), true, ok);
        }
        for (const bad of ["", "1.0.0; rm -rf /", "[1.0,2.0)", "1.*", "--version", "1.0.0 2.0.0", undefined]) {
            assert.strictEqual(isValidPackageVersion(bad), false, String(bad));
        }
    });

    test("severity reads text and NuGet numbers, unknown ranks lowest", () => {
        assert.strictEqual(normalizeSeverity("HIGH"), "High");
        assert.strictEqual(normalizeSeverity(3), "Critical");
        assert.strictEqual(normalizeSeverity(0), "Low");
        assert.strictEqual(normalizeSeverity("weird"), undefined);
        assert.ok(severityRank("Critical") > severityRank("High"));
        assert.ok(severityRank("Low") > severityRank("weird"));
        assert.strictEqual(severityRank(undefined), 0);
    });
});
