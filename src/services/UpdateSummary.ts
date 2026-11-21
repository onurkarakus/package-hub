import * as vscode from "vscode";
import { isPrereleaseVersion, versionChange, VersionChange } from "../utils/nugetAudit";

export interface UpdateSummaryProject {
    name: string;
    fromVersion?: string;
    relation: "direct" | "transitive";
}

export interface UpdateSummaryAdvisory {
    url: string;
    label: string;
    /** Whether the target version is still inside the advisory range. */
    verdict: "open" | "closed" | "unknown";
}

export interface UpdateSummaryInput {
    packageId: string;
    targetVersion?: string;
    projects: UpdateSummaryProject[];
    advisories: UpdateSummaryAdvisory[];
    /** Files written directly, for example Directory.Packages.props. */
    centralFiles: string[];
    /** True when dotnet add package will write PackageVersion through CPM. */
    usesCentralPackageManagement: boolean;
    releaseAgeNotice?: string;
    youngerThanAgeGate?: boolean;
}

export interface UpdateSummary {
    heading: string;
    change: VersionChange;
    lines: string[];
}

function changeText(change: VersionChange): string {
    switch (change) {
        case "major": return vscode.l10n.t("Major update. Breaking changes are possible.");
        case "minor": return vscode.l10n.t("Minor update. New features, the same major.");
        case "patch": return vscode.l10n.t("Patch update. Fixes in the same minor.");
        case "revision": return vscode.l10n.t("Revision update in the same patch.");
        case "prerelease": return vscode.l10n.t("Prerelease change in the same version.");
        case "same": return vscode.l10n.t("The version does not change.");
        case "downgrade": return vscode.l10n.t("This is a downgrade.");
        default: return vscode.l10n.t("The change type is unknown: the current version is a range, a floating version or a property.");
    }
}

function worstChange(changes: VersionChange[]): VersionChange {
    const order: VersionChange[] = ["downgrade", "major", "unknown", "minor", "patch", "revision", "prerelease", "same"];
    for (const change of order) {
        if (changes.includes(change)) {
            return change;
        }
    }
    return "unknown";
}

/**
 * Builds the explanation shown before an update is confirmed. It uses only
 * data PackageHub already has: the last scan, the advisory ranges and the
 * project files. Nothing here runs dotnet or touches the network.
 */
export function buildUpdateSummary(input: UpdateSummaryInput): UpdateSummary {
    const target = input.targetVersion;
    const froms = [...new Set(input.projects.map((project) => project.fromVersion).filter((value): value is string => !!value))];
    const fromText = froms.length === 0
        ? ""
        : froms.length === 1
            ? froms[0]
            : froms.join(" / ");
    const heading = target
        ? fromText ? `${input.packageId} ${fromText} → ${target}` : `${input.packageId} → ${target}`
        : vscode.l10n.t("{0} → the latest version dotnet picks", input.packageId);

    const changes = target
        ? (froms.length > 0 ? froms.map((from) => versionChange(from, target)) : ["unknown" as VersionChange])
        : ["unknown" as VersionChange];
    const change = worstChange(changes);
    const lines: string[] = [];

    if (target) {
        lines.push(changeText(change));
    } else {
        lines.push(vscode.l10n.t("No version was suggested. dotnet will pick the latest version."));
    }
    if (froms.length > 1) {
        lines.push(vscode.l10n.t("The projects use different versions now: {0}.", froms.join(", ")));
    }

    if (target && isPrereleaseVersion(target)) {
        const fromStable = froms.some((from) => !isPrereleaseVersion(from));
        lines.push(fromStable
            ? vscode.l10n.t("{0} is a prerelease. This moves a stable version to a prerelease.", target)
            : vscode.l10n.t("{0} is a prerelease.", target));
    }

    for (const advisory of input.advisories) {
        if (advisory.verdict === "closed") {
            lines.push(vscode.l10n.t("Closes {0}.", advisory.label));
        } else if (advisory.verdict === "open") {
            lines.push(vscode.l10n.t("{0} stays open in {1}.", advisory.label, target ?? vscode.l10n.t("the new version")));
        } else {
            lines.push(vscode.l10n.t("No local record says whether {0} closes {1}.", target ?? vscode.l10n.t("the new version"), advisory.label));
        }
    }

    const direct = input.projects.filter((project) => project.relation === "direct").map((project) => project.name);
    const transitive = input.projects.filter((project) => project.relation === "transitive").map((project) => project.name);
    if (direct.length > 0) {
        lines.push(vscode.l10n.t("Direct reference in: {0}.", direct.join(", ")));
    }
    if (transitive.length > 0) {
        lines.push(vscode.l10n.t("Transitive in: {0}. A direct PackageReference will be added there to pin it.", transitive.join(", ")));
    }

    if (input.centralFiles.length > 0) {
        lines.push(vscode.l10n.t("Edits {0}.", input.centralFiles.join(", ")));
    } else if (input.usesCentralPackageManagement) {
        lines.push(vscode.l10n.t("Central Package Management is on. dotnet writes the version to Directory.Packages.props."));
    } else {
        lines.push(vscode.l10n.t("dotnet add package writes the version to the project files."));
    }

    if (input.youngerThanAgeGate && target) {
        lines.push(vscode.l10n.t("{0} is younger than packageHub.minimumReleaseAge.", target));
    }
    if (input.releaseAgeNotice) {
        lines.push(input.releaseAgeNotice);
    }

    return { heading, change, lines };
}
