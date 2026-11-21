import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
    defaultGlobalPackagesPath,
    describeUpdateDetails,
    diffDependencies,
    lowestVersion,
    normalizedVersionFolder,
    nuspecPath,
    parseNuspec,
    readCachedNuspec,
} from "../services/PackageDetails";

function nuspec(version: string, license: string, deps: string, notes = ""): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">
  <metadata>
    <id>Contoso.Lib</id>
    <version>${version}</version>
    <description>Tools &amp; helpers.</description>
    <license type="expression">${license}</license>
    <projectUrl>https://example.com/contoso</projectUrl>
    ${notes ? `<releaseNotes>${notes}</releaseNotes>` : ""}
    <dependencies>
      <group targetFramework="net8.0">${deps}</group>
    </dependencies>
  </metadata>
</package>`;
}

suite("Package details", () => {
    test("parses the nuspec metadata", () => {
        const info = parseNuspec(nuspec("1.0.0", "MIT", '<dependency id="A" version="1.0.0" />', "Fixed a crash."));
        assert.ok(info);
        assert.strictEqual(info.id, "Contoso.Lib");
        assert.strictEqual(info.version, "1.0.0");
        assert.strictEqual(info.description, "Tools & helpers.");
        assert.strictEqual(info.license, "MIT");
        assert.strictEqual(info.releaseNotes, "Fixed a crash.");
        assert.deepStrictEqual(info.groups, [{ framework: "net8.0", dependencies: [{ id: "A", range: "1.0.0" }] }]);
        assert.strictEqual(parseNuspec("<package><metadata></metadata></package>"), undefined);
    });

    test("normalizes version folders like the global packages folder", () => {
        assert.strictEqual(normalizedVersionFolder("1.0"), "1.0.0");
        assert.strictEqual(normalizedVersionFolder("1.0.0.0"), "1.0.0");
        assert.strictEqual(normalizedVersionFolder("1.2.3.4"), "1.2.3.4");
        assert.strictEqual(normalizedVersionFolder("2.0.0-Beta.1"), "2.0.0-beta.1");
        assert.strictEqual(nuspecPath("/p", "Contoso.Lib", "1.0"), path.join("/p", "contoso.lib", "1.0.0", "contoso.lib.nuspec"));
        assert.strictEqual(defaultGlobalPackagesPath({ NUGET_PACKAGES: "/cache" }, "/home/u"), "/cache");
        assert.strictEqual(defaultGlobalPackagesPath({}, "/home/u"), path.join("/home/u", ".nuget", "packages"));
    });

    test("diffs the dependencies of two versions", () => {
        const from = parseNuspec(nuspec("1.0.0", "MIT", '<dependency id="A" version="1.0.0" /><dependency id="B" version="2.0.0" />'))!;
        const to = parseNuspec(nuspec("1.1.0", "Apache-2.0", '<dependency id="A" version="1.2.0" /><dependency id="C" version="3.0.0" />'))!;
        assert.deepStrictEqual(diffDependencies(from, to), { added: ["C 3.0.0"], removed: ["B"], changed: ["A 1.0.0 → 1.2.0"] });
        const lines = describeUpdateDetails({ packageId: "Contoso.Lib", toVersion: "1.1.0", to, from, fromVersion: "1.0.0", source: "cache", online: false });
        assert.strictEqual(lines[0], "What's in 1.1.0 (read from the local NuGet cache):");
        assert.ok(lines.includes("• License changes: MIT → Apache-2.0"));
        assert.ok(lines.includes("• New dependencies: C 3.0.0"));
        assert.ok(lines.includes("• Dropped dependencies: B"));
        assert.ok(lines.includes("• Changed dependencies: A 1.0.0 → 1.2.0"));
    });

    test("says when the metadata is not on this machine", () => {
        const lines = describeUpdateDetails({ packageId: "Contoso.Lib", toVersion: "9.0.0", online: false });
        assert.strictEqual(lines.length, 1);
        assert.match(lines[0], /packageHub\.onlineLookups/);
    });

    test("reads a nuspec from a global packages folder", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "ph-nuspec-"));
        try {
            const dir = path.join(root, "contoso.lib", "1.0.0");
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(path.join(dir, "contoso.lib.nuspec"), nuspec("1.0.0", "MIT", ""));
            const info = await readCachedNuspec(root, "Contoso.Lib", "1.0.0");
            assert.strictEqual(info?.license, "MIT");
            assert.strictEqual(await readCachedNuspec(root, "Contoso.Lib", "2.0.0"), undefined);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    test("picks the lowest exact version", () => {
        assert.strictEqual(lowestVersion(["1.2.0", undefined, "1.10.0", "[1.0, 2.0)", "1.1.9"]), "1.1.9");
        assert.strictEqual(lowestVersion([]), undefined);
    });
});
