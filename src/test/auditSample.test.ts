import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { directReferencer, GraphBuilder } from "../services/GraphBuilder";

suite("Audit sample", function () {
    this.timeout(180000);

    test("the extension is active in the sample workspace", async () => {
        const folder = workspaceFolder();
        assert.ok(folder.fsPath.endsWith(path.join("samples", "audit-quickfix")));

        const extension = vscode.extensions.getExtension("packagehub.package-hub");
        assert.ok(extension, "packagehub.package-hub is not installed");
        await extension.activate();

        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes("packageHub.scanWorkspace"));
        assert.ok(commands.includes("packageHub.copyHealthReport"));
        assert.ok(commands.includes("packageHub.copyVulnerabilityReport"));
        assert.strictEqual(
            vscode.workspace.getConfiguration("packageHub").get("telemetry"),
            undefined
        );
        assert.notStrictEqual(
            vscode.workspace.getConfiguration("packageHub").get("includePrerelease"),
            true
        );
        assert.deepStrictEqual(extension.packageJSON.activationEvents, [
            "onLanguage:csharp",
            "workspaceContains:**/*.{csproj,sln,props}",
        ]);
    });

    test("the marketplace icon is a png and the activity bar stays a codicon", async () => {
        const extension = vscode.extensions.getExtension("packagehub.package-hub");
        assert.ok(extension);
        const manifest = extension.packageJSON;
        assert.strictEqual(manifest.icon, "media/packagehub-logo.png");
        assert.strictEqual(manifest.galleryBanner.color, "#184E57");
        assert.strictEqual(manifest.galleryBanner.theme, "dark");
        assert.strictEqual(
            manifest.contributes.viewsContainers.activitybar[0].icon,
            "$(package)"
        );

        const iconPath = path.join(extension.extensionPath, manifest.icon);
        const bytes = await fs.readFile(iconPath);
        assert.strictEqual(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
        assert.ok(bytes.readUInt32BE(16) >= 128);
        assert.ok(bytes.readUInt32BE(20) >= 128);

        const ignore = await fs.readFile(path.join(extension.extensionPath, ".vscodeignore"), "utf8");
        assert.strictEqual(ignore.includes("media/"), false);
        assert.strictEqual(ignore.includes("*.png"), false);
    });

    test("the sample graph keeps Newtonsoft direct in AuditQuickFix", async () => {
        const folder = workspaceFolder();
        const audit = await GraphBuilder.fromProject(vscode.Uri.joinPath(folder, "AuditQuickFix.csproj").fsPath);
        const consumer = await GraphBuilder.fromProject(vscode.Uri.joinPath(folder, "Consumer", "Consumer.csproj").fsPath);

        assert.strictEqual(audit.error, undefined);
        assert.deepStrictEqual(directReferencer(audit, "Newtonsoft.Json"), {
            known: true,
            inGraph: true,
        });
        assert.deepStrictEqual(directReferencer(consumer, "Newtonsoft.Json"), {
            known: true,
            inGraph: true,
            broughtBy: "AuditQuickFix",
            broughtByKind: "project",
        });
    });

    test("a scan warns on both projects and leaves the pin", async () => {
        const folder = workspaceFolder();
        const propsUri = vscode.Uri.joinPath(folder, "Directory.Packages.props");
        const auditUri = vscode.Uri.joinPath(folder, "AuditQuickFix.csproj");
        const consumerUri = vscode.Uri.joinPath(folder, "Consumer", "Consumer.csproj");
        const propsBefore = await fs.readFile(propsUri.fsPath, "utf8");
        const auditBefore = await fs.readFile(auditUri.fsPath, "utf8");
        assert.match(propsBefore, /Include="Newtonsoft\.Json"\s+Version="12\.0\.1"/);

        await vscode.commands.executeCommand("packageHub.scanWorkspace");

        const auditMessages = packageHubMessages(auditUri);
        const consumerMessages = packageHubMessages(consumerUri);
        assert.ok(
            auditMessages.some((message) =>
                message.includes("Package 'Newtonsoft.Json' 12.0.1 has a known high severity vulnerability")
                && !message.includes("transitive")
            ),
            `AuditQuickFix diagnostics: ${auditMessages.join(" | ")}`
        );
        assert.ok(
            consumerMessages.some((message) =>
                message.includes("Package 'Newtonsoft.Json' 12.0.1 is transitive via AuditQuickFix")
                && !message.includes("this warning may be left over in the package graph")
            ),
            `Consumer diagnostics: ${consumerMessages.join(" | ")}`
        );

        assert.strictEqual(await fs.readFile(propsUri.fsPath, "utf8"), propsBefore);
        assert.strictEqual(await fs.readFile(auditUri.fsPath, "utf8"), auditBefore);
    });
});

function workspaceFolder(): vscode.Uri {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    assert.ok(folder, "audit sample workspace is not open");
    return folder;
}

function packageHubMessages(uri: vscode.Uri): string[] {
    return vscode.languages.getDiagnostics(uri)
        .filter((diagnostic) => diagnostic.source === "PackageHub")
        .map((diagnostic) => diagnostic.message);
}
