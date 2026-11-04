import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
    assetsFileFromFiles,
    evaluateFromFiles,
    findNearestFile,
    parseMsbuildEvaluation,
    planVersionEdit,
    readXmlProperty,
    setPackageVersionInXml,
} from "../services/ProjectEvaluation";

async function tempTree(files: Record<string, string>): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "packagehub-eval-"));
    for (const [name, text] of Object.entries(files)) {
        const file = path.join(root, name);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, text);
    }
    return root;
}

suite("Project evaluation", () => {
    test("msbuild -getItem JSON is read", () => {
        const projectPath = path.resolve("/repo/src/Api/Api.csproj");
        const evaluation = parseMsbuildEvaluation(projectPath, JSON.stringify({
            Properties: {
                ManagePackageVersionsCentrally: "true",
                DirectoryPackagesPropsPath: "/repo/Directory.Packages.props",
                ProjectAssetsFile: "/repo/artifacts/obj/Api/project.assets.json",
            },
            Items: {
                PackageReference: [
                    { Identity: "Newtonsoft.Json", VersionOverride: "13.0.3", DefiningProjectFullPath: projectPath },
                    { Identity: "Serilog", DefiningProjectFullPath: projectPath },
                ],
                PackageVersion: [{ Identity: "Serilog", Version: "3.1.1", DefiningProjectFullPath: "/repo/Directory.Packages.props" }],
                GlobalPackageReference: [{ Identity: "Analyzers", Version: "1.0.0", DefiningProjectFullPath: "/repo/Directory.Packages.props" }],
            },
        }));
        assert.strictEqual(evaluation.source, "msbuild");
        assert.strictEqual(evaluation.cpmEnabled, true);
        assert.strictEqual(evaluation.assetsFile, "/repo/artifacts/obj/Api/project.assets.json");
        assert.strictEqual(evaluation.packageReferences[0].versionOverride, "13.0.3");
        assert.strictEqual(evaluation.packageVersions[0].version, "3.1.1");

        assert.deepStrictEqual(planVersionEdit(evaluation, projectPath, "newtonsoft.json"), {
            kind: "xml-edit", filePath: projectPath, tag: "PackageReference", attribute: "VersionOverride",
        });
        assert.deepStrictEqual(planVersionEdit(evaluation, projectPath, "Analyzers"), {
            kind: "xml-edit", filePath: "/repo/Directory.Packages.props", tag: "GlobalPackageReference", attribute: "Version",
        });
        assert.deepStrictEqual(planVersionEdit(evaluation, projectPath, "Serilog"), { kind: "dotnet-add", projectPath });
        assert.deepStrictEqual(planVersionEdit(undefined, projectPath, "Serilog"), { kind: "dotnet-add", projectPath });
    });

    test("XML version edits touch only the value", () => {
        const xml = [
            "<Project>",
            "  <ItemGroup>",
            "    <!-- <PackageVersion Include=\"Serilog\" Version=\"1.0.0\" /> -->",
            "    <PackageVersion Include='Serilog' Version='3.1.1' />",
            "    <GlobalPackageReference Include=\"Analyzers\" Version=\"1.0.0\" PrivateAssets=\"all\" />",
            "    <PackageReference Include=\"Newtonsoft.Json\" VersionOverride=\"13.0.1\" />",
            "  </ItemGroup>",
            "</Project>",
        ].join("\n");
        const serilog = setPackageVersionInXml(xml, "PackageVersion", "serilog", "Version", "3.1.2");
        assert.ok(serilog?.includes("<PackageVersion Include='Serilog' Version='3.1.2' />"));
        assert.ok(serilog?.includes("<!-- <PackageVersion Include=\"Serilog\" Version=\"1.0.0\" /> -->"));
        assert.strictEqual(serilog?.length, xml.length);

        const global = setPackageVersionInXml(xml, "GlobalPackageReference", "Analyzers", "Version", "2.0.0");
        assert.ok(global?.includes("Version=\"2.0.0\" PrivateAssets=\"all\""));

        const override = setPackageVersionInXml(xml, "PackageReference", "Newtonsoft.Json", "VersionOverride", "13.0.3");
        assert.ok(override?.includes("VersionOverride=\"13.0.3\""));

        assert.strictEqual(setPackageVersionInXml(xml, "PackageVersion", "Missing", "Version", "1.0.0"), undefined);
        assert.strictEqual(setPackageVersionInXml(xml, "PackageReference", "Newtonsoft.Json", "Version", "1.0.0"), undefined);
    });

    test("XML properties ignore comments and take the last value", () => {
        const xml = "<!-- <UseArtifactsOutput>true</UseArtifactsOutput> --><PropertyGroup><Foo>a</Foo><Foo> b </Foo></PropertyGroup>";
        assert.strictEqual(readXmlProperty(xml, "UseArtifactsOutput"), undefined);
        assert.strictEqual(readXmlProperty(xml, "Foo"), "b");
    });

    test("the nearest Directory.Packages.props wins", async () => {
        const root = await tempTree({
            "Directory.Packages.props": "<Project />",
            "src/Directory.Packages.props": "<Project />",
            "src/Api/Api.csproj": "<Project />",
        });
        assert.strictEqual(await findNearestFile(path.join(root, "src", "Api"), "Directory.Packages.props"), path.join(root, "src", "Directory.Packages.props"));
        await fs.rm(root, { recursive: true, force: true });
    });

    test("project.assets.json respects BaseIntermediateOutputPath and UseArtifactsOutput", async () => {
        const root = await tempTree({
            "Plain/Plain.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\" />",
            "Custom/Custom.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><BaseIntermediateOutputPath>build/obj/</BaseIntermediateOutputPath></PropertyGroup></Project>",
            "Directory.Build.props": "<Project><PropertyGroup><UseArtifactsOutput Condition=\"'$(X)' == ''\">false</UseArtifactsOutput></PropertyGroup></Project>",
            "art/Directory.Build.props": "<Project><PropertyGroup><UseArtifactsOutput>true</UseArtifactsOutput></PropertyGroup></Project>",
            "art/Lib/Lib.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\" />",
        });
        assert.strictEqual(await assetsFileFromFiles(path.join(root, "Plain", "Plain.csproj")), path.join(root, "Plain", "obj", "project.assets.json"));
        assert.strictEqual(await assetsFileFromFiles(path.join(root, "Custom", "Custom.csproj")), path.join(root, "Custom", "build", "obj", "project.assets.json"));
        assert.strictEqual(await assetsFileFromFiles(path.join(root, "art", "Lib", "Lib.csproj")), path.join(root, "art", "artifacts", "obj", "Lib", "project.assets.json"));
        await fs.rm(root, { recursive: true, force: true });
    });

    test("file fallback finds CPM enabled outside Directory.Packages.props", async () => {
        const root = await tempTree({
            "Directory.Build.props": "<Project><PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup></Project>",
            "Directory.Packages.props": [
                "<Project>",
                "  <ItemGroup>",
                "    <PackageVersion Include=\"Serilog\" Version=\"3.1.1\" />",
                "    <GlobalPackageReference Include=\"Analyzers\" Version=\"1.0.0\" />",
                "  </ItemGroup>",
                "</Project>",
            ].join("\n"),
            "src/Api/Api.csproj": [
                "<Project Sdk=\"Microsoft.NET.Sdk\">",
                "  <ItemGroup>",
                "    <PackageReference Include=\"Serilog\" />",
                "    <PackageReference",
                "      Include=\"Newtonsoft.Json\"",
                "      VersionOverride=\"13.0.3\" />",
                "  </ItemGroup>",
                "</Project>",
            ].join("\n"),
        });
        const projectPath = path.join(root, "src", "Api", "Api.csproj");
        const evaluation = await evaluateFromFiles(projectPath);
        assert.strictEqual(evaluation.source, "files");
        assert.strictEqual(evaluation.cpmEnabled, true);
        assert.strictEqual(evaluation.propsPath, path.join(root, "Directory.Packages.props"));
        assert.deepStrictEqual(evaluation.packageVersions.map((item) => [item.id, item.version]), [["Serilog", "3.1.1"]]);
        assert.deepStrictEqual(evaluation.globalPackageReferences.map((item) => item.definingFile), [path.join(root, "Directory.Packages.props")]);
        assert.deepStrictEqual(planVersionEdit(evaluation, projectPath, "Newtonsoft.Json"), {
            kind: "xml-edit", filePath: projectPath, tag: "PackageReference", attribute: "VersionOverride",
        });
        await fs.rm(root, { recursive: true, force: true });
    });
});
