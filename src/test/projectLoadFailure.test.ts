import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isProjectLoadFailure, projectLoadSummary } from "../services/ProjectLoadFailure";
import { findTargetsUnder, vsToolsPathFromTargets, vsToolsPropsXml } from "../services/VsToolsPath";

const webError = [
    'dotnet command failed: error: The imported project "C:\\Program Files\\dotnet\\sdk\\9.0.300\\Microsoft\\VisualStudio\\v17.0\\WebApplications\\Microsoft.WebApplication.targets" was not found.',
    'Confirm that the expression in the Import declaration "$(VSToolsPath)\\WebApplications\\Microsoft.WebApplication.targets" is correct, and that the file exists on disk.',
    "C:\\work\\ExternalWebServices.csproj",
].join(" ");

suite("Project load failure", () => {
    test("a missing WebApplication.targets import is a project load failure", () => {
        assert.strictEqual(isProjectLoadFailure(webError), true);
        assert.strictEqual(
            projectLoadSummary(webError),
            "dotnet could not find Microsoft.WebApplication.targets."
        );
    });

    test("a missing dotnet executable is not a project load failure", () => {
        assert.strictEqual(
            isProjectLoadFailure("`dotnet` was not found. Is the .NET SDK installed?"),
            false
        );
    });

    test("Visual Studio web targets resolve to the version directory", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "packagehub-vs-"));
        const targets = path.join(
            root,
            "MSBuild",
            "Microsoft",
            "VisualStudio",
            "v17.0",
            "WebApplications",
            "Microsoft.WebApplication.targets"
        );
        fs.mkdirSync(path.dirname(targets), { recursive: true });
        fs.writeFileSync(targets, "<Project />");

        assert.strictEqual(findTargetsUnder(root), targets);
        assert.strictEqual(
            vsToolsPathFromTargets(targets),
            path.join(root, "MSBuild", "Microsoft", "VisualStudio", "v17.0")
        );
        assert.ok(vsToolsPropsXml("C:\\VS & Tools").includes("C:\\VS &amp; Tools"));
        fs.rmSync(root, { recursive: true, force: true });
    });
});
