import * as assert from "assert";
import { markHover } from "../providers/PackageLineDecorations";

function args(link: string): unknown {
    return JSON.parse(decodeURIComponent(link.split("?")[1]));
}

suite("Line mark hover", () => {
    test("a vulnerable mark links to the update, the advisory and why", () => {
        const md = markHover("Newtonsoft.Json", { kind: "vulnerable", text: "⚠ 13.0.3", hover: "Vulnerable." }, "Shop.Api", "https://github.com/advisories/GHSA-5crp-9r3c-p9vr");
        const links = [...md.value.matchAll(/\]\((command:[^)]+)\)/g)].map((match) => match[1]);
        assert.strictEqual(links.length, 3);
        assert.ok(links[0].startsWith("command:packageHub.updateVulnerable?"));
        assert.deepStrictEqual(args(links[0]), { packageId: "Newtonsoft.Json", version: "13.0.3", projectName: "Shop.Api" });
        assert.ok(links[1].startsWith("command:packageHub.openAdvisory?"));
        assert.ok(links[2].startsWith("command:packageHub.whyPackage?"));
        const trusted = md.isTrusted as { enabledCommands: string[] };
        assert.ok(trusted.enabledCommands.includes("packageHub.updateVulnerable"));
    });

    test("a current mark offers no update and a bad advisory url is dropped", () => {
        const current = markHover("Serilog", { kind: "current", text: "✓", hover: "Current." }, undefined, undefined);
        assert.ok(!current.value.includes("packageHub.updateVulnerable"));
        assert.ok(current.value.includes("packageHub.whyPackage"));
        const bad = markHover("A", { kind: "vulnerable", text: "⚠ 1.0.1", hover: "x" }, undefined, "javascript:alert(1)");
        assert.ok(!bad.value.includes("packageHub.openAdvisory"));
    });
});
