import * as assert from "assert";
import { maskXmlComments, packageRefAtLine, readPackageRef, readPackageRefs } from "../utils/nugetAudit";

suite("Package references in MSBuild files", () => {
    test("comments are ignored", () => {
        const text = [
            "<ItemGroup>",
            "  <!-- <PackageReference Include=\"Old.Package\" Version=\"1.0.0\" /> -->",
            "  <!--",
            "  <PackageReference Include=\"Also.Old\" Version=\"1.0.0\" />",
            "  -->",
            "  <PackageReference Include=\"Live.Package\" Version=\"2.0.0\" />",
            "</ItemGroup>",
        ].join("\n");
        const refs = readPackageRefs(text);
        assert.deepStrictEqual(refs.map((ref) => ref.id), ["Live.Package"]);
        assert.strictEqual(refs[0].line, 5);
        assert.strictEqual(readPackageRef("<!-- <PackageReference Include=\"X\" Version=\"1.0.0\" /> -->"), undefined);
    });

    test("masking keeps line numbers", () => {
        const text = "a<!--\nb\n-->c";
        assert.strictEqual(maskXmlComments(text).split("\n").length, 3);
        assert.strictEqual(maskXmlComments(text).length, text.length);
    });

    test("single quotes, Update and spacing", () => {
        const refs = readPackageRefs([
            "<PackageReference Include='Serilog' Version='3.1.1' />",
            "<PackageReference Update = \"Dapper\"  Version = \"2.1.0\"/>",
        ].join("\n"));
        assert.deepStrictEqual(refs.map((ref) => [ref.id, ref.version, ref.attribute]), [
            ["Serilog", "3.1.1", "Include"],
            ["Dapper", "2.1.0", "Update"],
        ]);
    });

    test("Version is matched as a word, VersionOverride is read on its own", () => {
        const [ref] = readPackageRefs("<PackageReference Include=\"A\" VersionOverride=\"2.0.0\" />");
        assert.strictEqual(ref.declaredVersion, undefined);
        assert.strictEqual(ref.versionOverride, "2.0.0");
        assert.strictEqual(ref.version, "2.0.0");

        const [other] = readPackageRefs("<PackageReference Include=\"B\" MyVersion=\"9\" Version=\"1.0.0\" />");
        assert.strictEqual(other.declaredVersion, "1.0.0");
    });

    test("multi-line elements and child Version elements", () => {
        const text = [
            "<Project>",
            "  <ItemGroup>",
            "    <PackageReference",
            "        Include=\"Newtonsoft.Json\"",
            "        Version=\"12.0.1\" />",
            "    <PackageReference Include=\"Polly\">",
            "      <Version>8.0.0</Version>",
            "      <PrivateAssets>all</PrivateAssets>",
            "    </PackageReference>",
            "  </ItemGroup>",
            "</Project>",
        ].join("\r\n");
        const refs = readPackageRefs(text);
        assert.deepStrictEqual(refs.map((ref) => [ref.id, ref.version, ref.line, ref.endLine]), [
            ["Newtonsoft.Json", "12.0.1", 2, 4],
            ["Polly", "8.0.0", 5, 8],
        ]);
        assert.strictEqual(packageRefAtLine(text, 3)?.id, "Newtonsoft.Json");
        assert.strictEqual(packageRefAtLine(text, 7)?.id, "Polly");
        assert.strictEqual(packageRefAtLine(text, 9), undefined);
    });

    test("the first line of a multi-line element still reads the id", () => {
        assert.deepStrictEqual(readPackageRef("<PackageReference Include=\"Newtonsoft.Json\""), {
            id: "Newtonsoft.Json",
            version: undefined,
            kind: "reference",
        });
    });

    test("tags are recognised", () => {
        const refs = readPackageRefs([
            "<PackageVersion Include=\"A\" Version=\"1.0.0\" />",
            "<GlobalPackageReference Include=\"B\" Version=\"2.0.0\" />",
            "<PackageReferenceX Include=\"C\" />",
        ].join("\n"));
        assert.deepStrictEqual(refs.map((ref) => [ref.tag, ref.kind]), [
            ["PackageVersion", "version"],
            ["GlobalPackageReference", "reference"],
        ]);
    });
});
