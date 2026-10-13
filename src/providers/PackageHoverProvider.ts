import * as vscode from "vscode";
import { advisoryLabel, advisoryVerdict, firstFixedVersion } from "../services/AdvisoryCatalog";
import { latestReleasePreferred } from "../services/ReleaseAge";
import { ScanState } from "../services/ScanState";
import { WarningExplainer } from "../services/WarningExplainer";
import { WorkspaceScanner } from "../services/WorkspaceScanner";
import { readPackageRef, sameNuGetVersion } from "../utils/nugetAudit";
import { PackageCodeActionProvider } from "./PackageCodeActionProvider";

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

export function hoverActionChip(
    icon: string,
    label: string,
    destination: string,
    primary = false
): string {
    const color = primary
        ? "var(--vscode-button-foreground)"
        : "var(--vscode-button-secondaryForeground)";
    const background = primary
        ? "var(--vscode-button-background)"
        : "var(--vscode-button-secondaryBackground)";
    const style = `color:${color};background-color:${background};border-radius:4px;`;
    const href = destination
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;");
    return `<a href="${href}"><span style="${style}">&nbsp;$(${icon})&nbsp;${escapeHtml(label)}&nbsp;</span></a>`;
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
        md.supportThemeIcons = true;

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

        if (explanation.isVulnerable || explanation.isDeprecated || explanation.isOutdated) {
            await this.appendTargetNotes(
                lines,
                document,
                packageId,
                currentVersion,
                explanation.isVulnerable,
                explanation.advisoryUrl
            );
        }
        const projectName = this.projectName(document);
        const peek = await this.versions.peekUpdateTargets(document, packageId, currentVersion);
        const fixedLink = explanation.isVulnerable
            ? this.firstFixedLink(
                packageId,
                projectName,
                currentVersion,
                explanation.advisoryUrl,
                peek
            )
            : undefined;
        const updates = [
            this.versionLink("patch", packageId, projectName, peek, explanation.advisoryUrl),
            this.versionLink("latest", packageId, projectName, peek, explanation.advisoryUrl),
            ...(fixedLink ? [fixedLink] : []),
        ];
        const others = [
            explanation.advisoryUrl
                ? hoverActionChip("link-external", "Open Advisory", explanation.advisoryUrl)
                : hoverActionChip("link-external", "Open Advisory", "command:packageHub.openAdvisory"),
            this.whyLink(packageId, projectName),
            hoverActionChip(
                "eye-closed",
                "Ignore",
                `command:packageHub.ignorePackage?${encodeURIComponent(JSON.stringify(packageId))}`
            ),
            this.removeLink(packageId, projectName),
        ];
        lines.push("");
        lines.push(updates.join(" &nbsp; "));
        lines.push(others.join(" &nbsp; "));

        md.appendMarkdown(lines.join("<br>"));
        return new vscode.Hover(md);
    }

    private async appendTargetNotes(
        lines: string[],
        document: vscode.TextDocument,
        packageId: string,
        currentVersion: string | undefined,
        vulnerable: boolean,
        advisoryUrl: string | undefined
    ): Promise<void> {
        const peek = await this.versions.peekUpdateTargets(document, packageId, currentVersion);
        const fixed = vulnerable
            ? this.distinctFixed(packageId, currentVersion, advisoryUrl, peek)
            : undefined;
        if (!peek.ready) {
            if (vulnerable) {
                lines.push(
                    "Updates stay on the lightbulb: highest patch, then latest. This hover does not pick a version until that list is ready."
                );
                if (fixed) {
                    lines.push(`First fixed \`${escapeHtml(fixed)}\``);
                    lines.push(this.verdictSentence(fixed, packageId, advisoryUrl));
                }
            }
            return;
        }

        const versions: string[] = [];
        if (peek.patch) {
            versions.push(`Highest patch \`${escapeHtml(peek.patch)}\``);
        }
        if (peek.latest) {
            versions.push(`Latest \`${escapeHtml(peek.latest)}\``);
        }
        if (fixed) {
            versions.push(`First fixed \`${escapeHtml(fixed)}\``);
        }
        if (versions.length > 0) {
            lines.push(versions.join(" · "));
        }
        if (peek.latest && peek.latestPreferred === false) {
            lines.push(
                `\`${escapeHtml(peek.latest)}\` is younger than the age gate. Highest patch stays the preferred update.`
            );
        }
        if (vulnerable && peek.patch) {
            lines.push("Highest patch stays in the same major.");
        }
        if (vulnerable && (peek.patch || peek.latest || fixed)) {
            for (const version of [peek.patch, peek.latest, fixed]) {
                if (version) {
                    lines.push(this.verdictSentence(version, packageId, advisoryUrl));
                }
            }
        }
        if (!peek.patch && !peek.latest && !fixed) {
            lines.push("No newer patch or latest version. Update was not started.");
        }
    }

    private verdictSentence(
        version: string,
        packageId: string,
        advisoryUrl: string | undefined
    ): string {
        const verdict = advisoryVerdict(packageId, advisoryUrl, version);
        const shown = escapeHtml(version);
        const label = escapeHtml(advisoryLabel(advisoryUrl));
        if (verdict === "open") {
            return `\`${shown}\` leaves ${label} open.`;
        }
        if (verdict === "closed") {
            return `\`${shown}\` closes ${label}.`;
        }
        return `\`${shown}\` has no advisory record. This window does not claim it closes the advisory.`;
    }

    private projectName(document: vscode.TextDocument): string | undefined {
        return document.fileName.toLowerCase().endsWith(".csproj")
            ? this.scanner.getProjectName(document.uri)
            : undefined;
    }

    private distinctFixed(
        packageId: string,
        currentVersion: string | undefined,
        advisoryUrl: string | undefined,
        peek: { patch?: string; latest?: string }
    ): string | undefined {
        const fixed = firstFixedVersion(packageId, advisoryUrl, currentVersion);
        if (!fixed || sameNuGetVersion(fixed, peek.patch) || sameNuGetVersion(fixed, peek.latest)) {
            return undefined;
        }

        return fixed;
    }

    private firstFixedLink(
        packageId: string,
        projectName: string | undefined,
        currentVersion: string | undefined,
        advisoryUrl: string | undefined,
        peek: { patch?: string; latest?: string }
    ): string | undefined {
        const fixed = this.distinctFixed(packageId, currentVersion, advisoryUrl, peek);
        if (!fixed) {
            return undefined;
        }

        const verdict = advisoryVerdict(packageId, advisoryUrl, fixed);
        if (verdict !== "closed") {
            return undefined;
        }

        return this.updateLink("shield", `First fixed ${fixed}`, packageId, fixed, projectName);
    }

    private versionLink(
        channel: "patch" | "latest",
        packageId: string,
        projectName: string | undefined,
        peek: { ready: boolean; patch?: string; latest?: string; latestPreferred?: boolean },
        advisoryUrl?: string
    ): string {
        const version = channel === "patch" ? peek.patch : peek.latest;
        const icon = channel === "patch" ? "arrow-circle-up" : "tag";
        const label = channel === "patch" ? "Highest patch" : "Latest";
        if (peek.ready && version) {
            return this.updateLink(
                icon,
                `${label} ${version}`,
                packageId,
                version,
                projectName,
                channel === "patch"
            );
        }

        const message = peek.ready
            ? `No ${channel} version for ${packageId}. The update was not started.`
            : "The patch list is not ready yet. The update was not started.";
        return hoverActionChip(
            icon,
            label,
            `command:packageHub.quickFixBlocked?${encodeURIComponent(JSON.stringify(message))}`
        );
    }

    private removeLink(packageId: string, projectName?: string): string {
        const args = projectName ? { packageId, projectName } : { packageId };
        return hoverActionChip(
            "trash",
            "Remove",
            `command:packageHub.removePackage?${encodeURIComponent(JSON.stringify(args))}`
        );
    }

    private whyLink(packageId: string, projectName?: string): string {
        const args = projectName ? { packageId, projectName } : { packageId };
        return hoverActionChip(
            "question",
            "Why",
            `command:packageHub.whyPackage?${encodeURIComponent(JSON.stringify(args))}`
        );
    }

    private updateLink(
        icon: string,
        label: string,
        packageId: string,
        version: string,
        projectName?: string,
        primary = false
    ): string {
        const args = projectName
            ? { packageId, version, projectName }
            : { packageId, version };
        return hoverActionChip(
            icon,
            label,
            `command:packageHub.updateVulnerable?${encodeURIComponent(JSON.stringify(args))}`,
            primary
        );
    }
}
