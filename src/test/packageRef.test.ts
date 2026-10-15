import * as assert from "assert";
import { readPackageRef } from "../utils/nugetAudit";

suite("Package reference lines", () => {
    test("a global package reference stays a reference", () => {
        const ref = readPackageRef(
            '<GlobalPackageReference Include="Nerdbank.GitVersioning" Version="3.6.133" />'
        );

        assert.deepStrictEqual(ref, {
            id: "Nerdbank.GitVersioning",
            version: "3.6.133",
            kind: "reference",
        });
    });

    test("a central package version stays a version", () => {
        const ref = readPackageRef(
            '<PackageVersion Include="Newtonsoft.Json" Version="13.0.4" />'
        );

        assert.strictEqual(ref?.kind, "version");
        assert.strictEqual(ref?.id, "Newtonsoft.Json");
        assert.strictEqual(ref?.version, "13.0.4");
    });

    test("a package reference without a version stays a reference", () => {
        const ref = readPackageRef('<PackageReference Include="Newtonsoft.Json" />');

        assert.deepStrictEqual(ref, {
            id: "Newtonsoft.Json",
            version: undefined,
            kind: "reference",
        });
    });
});
