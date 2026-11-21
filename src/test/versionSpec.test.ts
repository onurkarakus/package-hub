import * as assert from "assert";
import { findPropertyDefinition, floatingAllows, planVersionWrite, readVersionSpec, setPropertyInXml } from "../services/VersionSpec";

suite("Version spec", () => {
    test("reads exact, range, floating and property versions", () => {
        assert.strictEqual(readVersionSpec("13.0.3").kind, "exact");
        assert.deepStrictEqual(readVersionSpec("[1.2.0, 2.0.0)"), {
            kind: "range", text: "[1.2.0, 2.0.0)", min: "1.2.0", minInclusive: true, max: "2.0.0", maxInclusive: false,
        });
        assert.deepStrictEqual(readVersionSpec("1.2.*"), { kind: "floating", text: "1.2.*", prefix: "1.2." });
        assert.deepStrictEqual(readVersionSpec("$(SerilogVersion)"), { kind: "property", text: "$(SerilogVersion)", name: "SerilogVersion" });
        assert.strictEqual(readVersionSpec("latest").kind, "unknown");
        assert.strictEqual(readVersionSpec(undefined).kind, "unknown");
    });

    test("floating versions allow only matching versions", () => {
        assert.strictEqual(floatingAllows("1.2.", "1.2.9"), true);
        assert.strictEqual(floatingAllows("1.2.", "1.3.0"), false);
        assert.strictEqual(floatingAllows("1.", "1.9.0"), true);
    });

    test("exact versions are written", () => {
        assert.deepStrictEqual(planVersionWrite("1.0.0", "1.0.5"), { kind: "write", text: "1.0.5" });
    });

    test("range updates stay inside the range and keep the upper bound", () => {
        assert.deepStrictEqual(planVersionWrite("[1.0.0, 2.0.0)", "1.4.0"), { kind: "write", text: "[1.4.0, 2.0.0)" });
        assert.deepStrictEqual(planVersionWrite("[1.0.0, )", "1.4.0"), { kind: "write", text: "[1.4.0, )" });
        assert.deepStrictEqual(planVersionWrite("[1.0.0]", "1.0.0"), { kind: "write", text: "[1.0.0]" });
        assert.strictEqual(planVersionWrite("[1.0.0, 2.0.0)", "2.1.0").kind, "refused");
        assert.strictEqual(planVersionWrite("[1.4.0, 2.0.0)", "1.4.0").kind, "restore-only");
    });

    test("floating versions restore when they already cover the target", () => {
        assert.strictEqual(planVersionWrite("1.*", "1.5.0").kind, "restore-only");
        assert.strictEqual(planVersionWrite("1.*", "2.0.0").kind, "refused");
    });

    test("property versions point at the property", () => {
        assert.deepStrictEqual(planVersionWrite("$(SerilogVersion)", "3.1.1"), { kind: "property", name: "SerilogVersion" });
        assert.strictEqual(planVersionWrite("whatever", "1.0.0").kind, "refused");
    });

    test("finds the last plain property definition", () => {
        const files = [
            { filePath: "/a/Directory.Build.props", text: "<Project><PropertyGroup><SerilogVersion>3.0.0</SerilogVersion></PropertyGroup></Project>" },
            { filePath: "/a/App.csproj", text: "<Project><PropertyGroup><SerilogVersion>3.1.0</SerilogVersion></PropertyGroup></Project>" },
        ];
        assert.deepStrictEqual(findPropertyDefinition(files, "SerilogVersion"), { filePath: "/a/App.csproj", value: "3.1.0" });
        assert.strictEqual(findPropertyDefinition(files, "Missing"), undefined);
        const conditional = [{ filePath: "/a/x.props", text: "<Project><PropertyGroup Condition=\"'$(X)'=='1'\"><V>1.0.0</V></PropertyGroup></Project>" }];
        assert.strictEqual(findPropertyDefinition(conditional, "V"), "conditional");
        const commented = [{ filePath: "/a/x.props", text: "<Project><!-- <V>9.0.0</V> --><PropertyGroup><V>1.0.0</V></PropertyGroup></Project>" }];
        assert.deepStrictEqual(findPropertyDefinition(commented, "V"), { filePath: "/a/x.props", value: "1.0.0" });
    });

    test("sets a property value and leaves the rest of the file alone", () => {
        const xml = "<Project>\n  <PropertyGroup>\n    <SerilogVersion>3.0.0</SerilogVersion>\n  </PropertyGroup>\n</Project>\n";
        assert.strictEqual(setPropertyInXml(xml, "SerilogVersion", "3.1.1"), xml.replace("3.0.0", "3.1.1"));
        assert.strictEqual(setPropertyInXml(xml, "Other", "1.0.0"), undefined);
    });
});
