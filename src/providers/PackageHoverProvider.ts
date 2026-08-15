import * as vscode from "vscode";
import { ScanState } from "../services/ScanState";
import { WarningExplainer } from "../services/WarningExplainer";

export class PackageHoverProvider implements vscode.HoverProvider {
    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Hover> {
        const line = document.lineAt(position.line).text;

        const match = line.match(
            /PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]+)")?/i
        );

        if (!match) {
            return null;
        }

        const packageId = match[1];
        const version = match[2] || "unknown";

        const { vulnerable, outdated } = ScanState.findPackage(packageId);
        const explanation = WarningExplainer.explain(
            packageId,
            version,
            vulnerable,
            outdated
        );

        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        md.supportHtml = true;

        // Başlık
        md.appendMarkdown(`### 📦 ${explanation.title}\n\n`);
        md.appendMarkdown(`**Current Version:** \`${version}\`\n\n`);

        if (explanation.isVulnerable) {
            md.appendMarkdown(`---\n\n`);
            md.appendMarkdown(`### ⚠ ${explanation.reason}\n\n`);
            md.appendMarkdown(`**Severity:** \`${explanation.severity}\`\n\n`);

            if (explanation.recommendedVersion) {
                md.appendMarkdown(
                    `**Recommended:** Update to \`${explanation.recommendedVersion}\`\n\n`
                );
            }

            // Aksiyonlar
            md.appendMarkdown(`\n`);
            if (explanation.recommendedVersion) {
                md.appendMarkdown(
                    `[Update to ${explanation.recommendedVersion}](command:packageHub.updateVulnerable?${encodeURIComponent(JSON.stringify({ packageId, version: explanation.recommendedVersion }))})`
                );
                md.appendMarkdown(`  |  `);
            }
            if (explanation.advisoryUrl) {
                md.appendMarkdown(`[Open Advisory](${explanation.advisoryUrl})`);
            }
        } else if (explanation.isOutdated) {
            md.appendMarkdown(`---\n\n`);
            md.appendMarkdown(`### 🟠 ${explanation.reason}\n\n`);
            md.appendMarkdown(
                `**Latest Version:** \`${explanation.recommendedVersion || "?"}\`\n\n`
            );

            if (explanation.recommendedVersion) {
                md.appendMarkdown(
                    `[Update to ${explanation.recommendedVersion}](command:packageHub.updateVulnerable?${encodeURIComponent(JSON.stringify({ packageId, version: explanation.recommendedVersion }))})`
                );
            }
        } else {
            md.appendMarkdown(`---\n\n`);
            md.appendMarkdown(`✅ ${explanation.reason}\n\n`);
            md.appendMarkdown(`*Run **PackageHub: Scan Workspace** for the latest data.*`);
        }

        // Alt bilgi
        md.appendMarkdown(`\n\n---\n`);
        md.appendMarkdown(`[Scan Workspace](command:packageHub.scanWorkspace)`);

        return new vscode.Hover(md);
    }
}