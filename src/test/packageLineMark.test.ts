import * as assert from "assert";
import { packageLineFacts, packageLineMark } from "../providers/packageLineMark";

suite("Package line mark", () => {
    test("an outdated package shows a cross and the newer version", () => {
        const mark = packageLineMark("0.11.3", {
            outdated: { version: "0.11.3", latestVersion: "0.12.4" },
        });

        assert.deepStrictEqual(mark, {
            kind: "outdated",
            text: "\u2715 0.12.4",
            hover: "Outdated. Newer version 0.12.4.",
        });
    });

    test("the newer version is the latest, not the same-major patch", () => {
        const mark = packageLineMark("12.0.1", {
            outdated: { version: "12.0.1", latestVersion: "13.0.4", highestPatch: "12.0.3" },
        });

        assert.strictEqual(mark?.text, "\u2715 13.0.4");
    });

    test("a missing latest falls back to the highest patch", () => {
        const mark = packageLineMark("12.0.1", {
            outdated: { version: "12.0.1", highestPatch: "12.0.3" },
        });

        assert.strictEqual(mark?.text, "\u2715 12.0.3");
    });

    test("an outdated number that is not newer is not drawn", () => {
        const mark = packageLineMark("0.12.4", {
            outdated: { version: "0.12.4", latestVersion: "0.12.4" },
        });

        assert.strictEqual(mark, undefined);
    });

    test("a vulnerable package keeps its own mark and can show the newer version", () => {
        const mark = packageLineMark("12.0.1", {
            vulnerable: { version: "12.0.1", severity: "High" },
            outdated: { version: "12.0.1", latestVersion: "13.0.4", highestPatch: "12.0.3" },
        });

        assert.deepStrictEqual(mark, {
            kind: "vulnerable",
            text: "\u26A0 13.0.4",
            hover: "Vulnerable, high severity. Newer version 13.0.4.",
        });
    });

    test("a vulnerable package without a newer version shows the warning only", () => {
        const mark = packageLineMark("12.0.1", {
            vulnerable: { version: "12.0.1", severity: "Critical" },
        });

        assert.deepStrictEqual(mark, {
            kind: "vulnerable",
            text: "\u26A0",
            hover: "Vulnerable, critical severity.",
        });
    });

    test("a deprecated package uses its own mark and can show the newer version", () => {
        const mark = packageLineMark("1.2.3", {
            deprecated: { version: "1.2.3" },
            outdated: { version: "1.2.3", latestVersion: "2.0.0" },
        });

        assert.deepStrictEqual(mark, {
            kind: "deprecated",
            text: "\u2298 2.0.0",
            hover: "Deprecated. Newer version 2.0.0.",
        });
    });

    test("a deprecated package without a newer version shows the mark only", () => {
        const mark = packageLineMark("1.2.3", {
            deprecated: { version: "1.2.3" },
        });

        assert.deepStrictEqual(mark, {
            kind: "deprecated",
            text: "\u2298",
            hover: "Deprecated.",
        });
    });

    test("a line whose version differs from the scan is left unmarked", () => {
        const mark = packageLineMark("13.0.1", {
            vulnerable: { version: "12.0.1", severity: "High", latestVersion: "13.0.4" },
            outdated: { version: "12.0.1", latestVersion: "13.0.4" },
        });

        assert.strictEqual(mark, undefined);
    });

    test("a line without a version still uses the scanned version", () => {
        const mark = packageLineMark(undefined, {
            outdated: { version: "0.10.0", latestVersion: "0.15.0" },
        });

        assert.strictEqual(mark?.text, "\u2715 0.15.0");
    });

    test("a package with no problem record is not marked", () => {
        assert.strictEqual(packageLineMark("1.0.0", {}), undefined);
    });

    test("a csproj mark stays on the project that owns the package", () => {
        const owned = packageLineFacts(
            { version: "0.11.3", latestVersion: "0.12.4", projects: ["Api"] },
            "api"
        );
        const other = packageLineFacts(
            { version: "0.11.3", latestVersion: "0.12.4", projects: ["Api"] },
            "Web"
        );

        assert.strictEqual(owned?.latestVersion, "0.12.4");
        assert.strictEqual(other, undefined);
    });

    test("a project uses its own scanned version when pins differ", () => {
        const facts = packageLineFacts(
            {
                version: "12.0.1",
                latestVersion: "13.0.4",
                projects: ["Api", "Web"],
                versionByProject: { Api: "12.0.1", Web: "13.0.4" },
            },
            "Web"
        );
        const mark = packageLineMark("13.0.4", { outdated: facts });

        assert.strictEqual(facts?.version, "13.0.4");
        assert.strictEqual(mark, undefined);
    });

    test("a current package shows a check and no version", () => {
        const mark = packageLineMark("1.2.3", {
            current: { version: "1.2.3" },
        });

        assert.deepStrictEqual(mark, {
            kind: "current",
            text: "\u2713",
            hover: "Current.",
        });
    });

    test("a problem mark wins over the current check", () => {
        const mark = packageLineMark("1.0.0", {
            outdated: { version: "1.0.0", latestVersion: "1.1.0" },
            current: { version: "1.0.0" },
        });

        assert.strictEqual(mark?.kind, "outdated");
    });

    test("a version that does not match the inventory draws no check", () => {
        const mark = packageLineMark("9.9.9", {
            current: { version: "1.2.3" },
        });

        assert.strictEqual(mark, undefined);
    });

    test("a line with no version still shows the current check", () => {
        const mark = packageLineMark(undefined, {
            current: { version: "1.2.3" },
        });

        assert.strictEqual(mark?.kind, "current");
        assert.strictEqual(mark?.text, "\u2713");
    });

    test("an outdated record that is not newer does not become a check", () => {
        const mark = packageLineMark("0.12.4", {
            outdated: { version: "0.12.4", latestVersion: "0.12.4" },
            current: { version: "0.12.4" },
        });

        assert.strictEqual(mark, undefined);
    });

    test("a props line can use a package recorded on any project", () => {
        const facts = packageLineFacts(
            { version: "0.11.3", latestVersion: "0.12.4", projects: ["Api"] },
            undefined
        );

        assert.strictEqual(facts?.version, "0.11.3");
    });
});
