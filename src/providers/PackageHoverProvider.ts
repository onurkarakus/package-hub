import * as vscode from "vscode";
import { ScanState } from "../services/ScanState";
import { WarningExplainer } from "../services/WarningExplainer";
import { WorkspaceScanner } from "../services/WorkspaceScanner";
import { readPackageRef } from "../utils/nugetAudit";
import { PackageCodeActionProvider } from "./PackageCodeActionProvider";

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function sentence(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
        return "";
    }
    return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

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
        const usesCentral = ref.kind === "version" || !ref.version;
        const centralVersion = ref.kind === "version"
            ? ref.version
            : ScanState.getCentralVersion(packageId);
        const currentVersion = usesCentral
            ? centralVersion
            : (ref.version || found.vulnerable?.version || found.outdated?.version);
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

        const lines: string[] = [];
        const versionText = `\`${escapeHtml(currentVersion || "unknown")}\`${usesCentral ? " · CPM" : ""}`;
        const header = [`**${escapeHtml(explanation.title)}**`];
        if (explanation.severity) {
            header.push(escapeHtml(explanation.severity));
        }
        header.push(versionText);
        lines.push(header.join(" · "));

        const notes = [sentence(explanation.reason)];
        if (usesCentral && centralVersion) {
            notes.push("Version is read from Directory.Packages.props.");
        }
        if (usesCentral && !centralVersion) {
            notes.push("No PackageVersion entry. No version was invented.");
        }
        if (!explanation.isVulnerable && !explanation.isDeprecated && !explanation.isOutdated) {
            notes.push("Run PackageHub: Scan Workspace for the latest data.");
        }
        lines.push(notes.join(" "));

        const links: string[] = [];
        if (explanation.isVulnerable || explanation.isDeprecated || explanation.isOutdated) {
            const wrote = await this.appendTargets(
                lines,
                links,
                document,
                packageId,
                currentVersion,
                explanation.isVulnerable
            );
            if (!wrote && explanation.isOutdated && explanation.recommendedVersion) {
                lines.push(`Latest \`${escapeHtml(explanation.recommendedVersion)}\``);
                links.push(this.updateLink(
                    `Update to latest ${explanation.recommendedVersion}`,
                    packageId,
                    explanation.recommendedVersion,
                    this.projectName(document)
                ));
            }
        }
        if (explanation.advisoryUrl) {
            links.push(`[Open Advisory](${explanation.advisoryUrl})`);
        }
        links.push(
            this.whyLink(packageId, this.projectName(document)),
            `[Scan Workspace](command:packageHub.scanWorkspace)`,
            `[Ignore](command:packageHub.ignorePackage?${encodeURIComponent(JSON.stringify(packageId))})`
        );
        lines.push(...links);

        md.appendMarkdown(lines.join("<br>"));
        return new vscode.Hover(md);
    }

    private async appendTargets(
        lines: string[],
        links: string[],
        document: vscode.TextDocument,
        packageId: string,
        currentVersion: string | undefined,
        vulnerable: boolean
    ): Promise<boolean> {
        const peek = await this.versions.peekUpdateTargets(document, packageId, currentVersion);
        if (!peek.ready) {
            if (vulnerable) {
                lines.push(
                    "Updates stay on the lightbulb: highest patch, then latest. This hover does not pick a version until that list is ready."
                );
            }
            return false;
        }

        const versions: string[] = [];
        if (peek.patch) {
            versions.push(`Highest patch \`${escapeHtml(peek.patch)}\``);
        }
        if (peek.latest) {
            versions.push(`Latest \`${escapeHtml(peek.latest)}\``);
        }
        if (versions.length > 0) {
            lines.push(versions.join(" · "));
        }
        if (vulnerable && peek.patch) {
            lines.push("Highest patch stays in the same major. This window does not claim that version closes the advisory.");
        }
        if (!peek.patch && !peek.latest) {
            lines.push("No newer patch or latest version. Update was not started.");
            return true;
        }

        const projectName = this.projectName(document);
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
        return true;
    }

    private projectName(document: vscode.TextDocument): string | undefined {
        return document.fileName.toLowerCase().endsWith(".csproj")
            ? this.scanner.getProjectName(document.uri)
            : undefined;
    }

    private whyLink(packageId: string, projectName?: string): string {
        const args = projectName ? { packageId, projectName } : { packageId };
        return `[Why is this here?](command:packageHub.whyPackage?${encodeURIComponent(JSON.stringify(args))})`;
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
