import * as assert from "assert";
import { isPackageProjectFile, ScanGate } from "../services/ScanGate";

suite("Scan gate", () => {
    test("project files are csproj and props only", () => {
        assert.strictEqual(isPackageProjectFile("/workspace/app/AuditQuickFix.csproj"), true);
        assert.strictEqual(isPackageProjectFile("/workspace/app/Directory.Packages.props"), true);
        assert.strictEqual(isPackageProjectFile("/workspace/app/Directory.Build.props"), true);
        assert.strictEqual(isPackageProjectFile("/workspace/app/Foo.CSProj"), true);
        assert.strictEqual(isPackageProjectFile("/workspace/app/Program.cs"), false);
        assert.strictEqual(isPackageProjectFile("/workspace/app/readme.md"), false);
        assert.strictEqual(isPackageProjectFile("/workspace/app/Directory.Build.targets"), false);
    });

    test("a second start waits for one follow-up", () => {
        const gate = new ScanGate();
        assert.strictEqual(gate.begin(), true);
        assert.strictEqual(gate.begin(), false);
        assert.strictEqual(gate.begin(), false);
        assert.strictEqual(gate.end(), true);
        assert.strictEqual(gate.end(), false);
        gate.forceIdle();
        assert.strictEqual(gate.begin(), true);
    });

    test("the follow-up keeps the gate held", () => {
        const gate = new ScanGate();
        assert.strictEqual(gate.begin(), true);
        assert.strictEqual(gate.begin(), false);
        assert.strictEqual(gate.end(), true);
        assert.strictEqual(gate.begin(), false);
        assert.strictEqual(gate.end(), true);
        assert.strictEqual(gate.end(), false);
    });
});
