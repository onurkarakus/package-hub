import * as assert from "assert";
import * as path from "path";
import { ProjectEvaluation } from "../services/ProjectEvaluation";
import { findUnusedCentralVersions, removePackageVersionsFromXml } from "../services/UnusedCentralVersions";

const props = `<Project>
  <ItemGroup>
    <PackageVersion Include="Serilog" Version="3.1.1" />
    <PackageVersion Include="Unused.Package" Version="1.0.0" />
    <!-- <PackageVersion Include="Commented" Version="1.0.0" /> -->
    <PackageVersion Include="Global.Analyzer" Version="2.0.0" />
    <PackageVersion Update="Serilog" Version="3.1.2" />
  </ItemGroup>
</Project>
`;

function evaluation(refs: string[], globals: string[] = []): ProjectEvaluation {
    return {
        packageReferences: refs.map((id) => ({ id })),
        globalPackageReferences: globals.map((id) => ({ id })),
    } as unknown as ProjectEvaluation;
}

suite("Unused central versions", () => {
    test("lists PackageVersion entries no project uses", () => {
        const file = path.resolve("/w/Directory.Packages.props");
        const unused = findUnusedCentralVersions([{ filePath: file, text: props }], [evaluation(["serilog"], ["Global.Analyzer"])]);
        assert.deepStrictEqual(unused.map((item) => [item.id, item.version, item.line]), [["Unused.Package", "1.0.0", 3]]);
        assert.strictEqual(unused[0].filePath, file);
    });

    test("removes whole lines and leaves comments alone", () => {
        const result = removePackageVersionsFromXml(props, ["unused.package", "Commented"]);
        assert.ok(!result.includes('Include="Unused.Package"'));
        assert.ok(result.includes("<!-- <PackageVersion Include=\"Commented\""));
        assert.strictEqual(result.split("\n").length, props.split("\n").length - 1);
        assert.strictEqual(removePackageVersionsFromXml(props, []), props);
    });
});
