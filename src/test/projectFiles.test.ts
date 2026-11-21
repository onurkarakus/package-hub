import * as assert from "assert";
import { isMsBuildProject, isPackageDocumentPath, isSolutionPath, projectNameFromPath } from "../services/projectFiles";

suite("Project files", () => {
    test("C#, F# and Visual Basic projects are MSBuild projects", () => {
        assert.strictEqual(isMsBuildProject("/w/App.csproj"), true);
        assert.strictEqual(isMsBuildProject("/w/Lib.FSPROJ"), true);
        assert.strictEqual(isMsBuildProject("/w/Legacy.vbproj"), true);
        assert.strictEqual(isMsBuildProject("/w/Directory.Build.props"), false);
        assert.strictEqual(isMsBuildProject("/w/App.sln"), false);
    });

    test("package documents include props files", () => {
        assert.strictEqual(isPackageDocumentPath("/w/Directory.Packages.props"), true);
        assert.strictEqual(isPackageDocumentPath("/w/Legacy.vbproj"), true);
        assert.strictEqual(isPackageDocumentPath("/w/readme.md"), false);
    });

    test("both solution formats are solutions", () => {
        assert.strictEqual(isSolutionPath("/w/App.sln"), true);
        assert.strictEqual(isSolutionPath("/w/App.slnx"), true);
        assert.strictEqual(isSolutionPath("/w/App.csproj"), false);
    });

    test("the project name drops the extension", () => {
        assert.strictEqual(projectNameFromPath("/w/Legacy/Legacy.vbproj"), "Legacy");
    });
});
