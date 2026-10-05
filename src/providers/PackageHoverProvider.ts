import * as vscode from "vscode";
import { ScanState } from "../services/ScanState";
import { WarningExplainer } from "../services/WarningExplainer";
import { WorkspaceScanner } from "../services/WorkspaceScanner";
import { readPackageRef } from "../utils/nugetAudit";
import { PackageCodeActionProvider } from "./PackageCodeActionProvider";

export class PackageHoverProvider implements vscode.HoverProvider {
    constructor(
        private readonly versions: PackageCodeActionProvider,
        private readonly scanner: WorkspaceScanner
    ) { }

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): Promise<vscode.Hover | null> {
        const ref = readPackageRef(document.lineAt(position.line).text);
        if (!ref) {
            return null;
        }

        const packageId = ref.id;
        const found = ScanState.findPackage(packageId);
        const currentVersion = ref.version || found.vulnerable?.version || found.outdated?.version;
        const explanation = WarningExplainer.explain(
            packageId,
            currentVersion || "unknown",
            found.vulnerable,
            found.outdated,
            found.deprecated
        );

        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        md.supportHtml = true;

        md.appendMarkdown(`### ${explanation.title}\n\n`);
        md.appendMarkdown(`**Current Version:** \`${currentVersion || "unknown"}\`\n\n`);

        if (explanation.isVulnerable) {
            md.appendMarkdown(`---\n\n`);
            md.appendMarkdown(`### ${explanation.reason}\n\n`);
            md.appendMarkdown(`**Severity:** \`${explanation.severity}\`\n\n`);
            await this.appendTargets(md, document, packageId, currentVersion, true);
            if (explanation.advisoryUrl) {
                md.appendMarkdown(`[Open Advisory](${explanation.advisoryUrl})`);
            }
        } else if (explanation.isDeprecated) {
            md.appendMarkdown(`---\n\n`);
            md.appendMarkdown(`### ${explanation.reason}\n\n`);
            await this.appendTargets(md, document, packageId, currentVersion, false);
        } else if (explanation.isOutdated) {
            md.appendMarkdown(`---\n\n`);
            md.appendMarkdown(`### ${explanation.reason}\n\n`);
            const wrote = await this.appendTargets(md, document, packageId, currentVersion, false);
            if (!wrote && explanation.recommendedVersion) {
                md.appendMarkdown(`**Latest:** \`${explanation.recommendedVersion}\`\n\n`);
                md.appendMarkdown(this.updateLink(
                    `Update to latest ${explanation.recommendedVersion}`,
                    packageId,
                    explanation.recommendedVersion,
                    this.projectName(document)
                ));
            }
        } else {
            md.appendMarkdown(`---\n\n`);
            md.appendMarkdown(`${explanation.reason}\n\n`);
            md.appendMarkdown(`*Run **PackageHub: Scan Workspace** for the latest data.*`);
        }

        md.appendMarkdown(`\n\n---\n`);
        md.appendMarkdown(`[Scan Workspace](command:packageHub.scanWorkspace)`);
        md.appendMarkdown(
            `\n\n[Ignore](command:packageHub.ignorePackage?${encodeURIComponent(
                JSON.stringify(packageId)
            )})`
        );

        return new vscode.Hover(md);
    }

    private async appendTargets(
        md: vscode.MarkdownString,
        document: vscode.TextDocument,
        packageId: string,
        currentVersion: string | undefined,
        vulnerable: boolean
    ): Promise<boolean> {
        const peek = await this.versions.peekUpdateTargets(document, packageId, currentVersion);
        if (!peek.ready) {
            if (vulnerable) {
                md.appendMarkdown(
                    `Updates stay on the lightbulb: highest patch, then latest. This hover does not pick a version until that list is ready.\n\n`
                );
            }
            return false;
        }

        if (peek.patch) {
            md.appendMarkdown(`**Highest patch:** \`${peek.patch}\`\n\n`);
        }
        if (peek.latest) {
            md.appendMarkdown(`**Latest:** \`${peek.latest}\`\n\n`);
        }
        if (vulnerable && peek.patch) {
            md.appendMarkdown(
                `Highest patch stays in the same major. This window does not claim that version closes the advisory.\n\n`
            );
        }
        if (!peek.patch && !peek.latest) {
            md.appendMarkdown(`No newer patch or latest version. Update was not started.\n\n`);
            return true;
        }

        const projectName = this.projectName(document);
        const links: string[] = [];
        if (peek.patch) {
            links.push(this.updateLink(
                `Update to highest patch ${peek.patch}`,
                packageId,
                peek.patch,
                projectName
            ));
        }
        if (peek.latest) {
            links.push(this.updateLink(
                `Update to latest ${peek.latest}`,
                packageId,
                peek.latest,
                projectName
            ));
        }
        md.appendMarkdown(`${links.join("  |  ")}\n\n`);
        return true;
    }

    private projectName(document: vscode.TextDocument): string | undefined {
        return document.fileName.toLowerCase().endsWith(".csproj")
            ? this.scanner.getProjectName(document.uri)
            : undefined;
    }

    private updateLink(
        label: string,
        packageId: string,
        version: string,
        projectName?: string
    ): string {
        const args = projectName
            ? { packageId, version, projectName }
            : { packageId, version };
        return `[${label}](command:packageHub.updateVulnerable?${encodeURIComponent(JSON.stringify(args))})`;
    }
}
