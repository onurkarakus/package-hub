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

const CHANGE_TEXT: Record<VersionChange, string> = {
    major: "Major update. Breaking changes are possible.",
    minor: "Minor update. New features, the same major.",
    patch: "Patch update. Fixes in the same minor.",
    revision: "Revision update in the same patch.",
    prerelease: "Prerelease change in the same version.",
    same: "The version does not change.",
    downgrade: "This is a downgrade.",
    unknown: "The change type is unknown: the current version is a range, a floating version or a property.",
};

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
        : `${input.packageId} → the latest version dotnet picks`;

    const changes = target
        ? (froms.length > 0 ? froms.map((from) => versionChange(from, target)) : ["unknown" as VersionChange])
        : ["unknown" as VersionChange];
    const change = worstChange(changes);
    const lines: string[] = [];

    if (target) {
        lines.push(CHANGE_TEXT[change]);
    } else {
        lines.push("No version was suggested. dotnet will pick the latest version.");
    }
    if (froms.length > 1) {
        lines.push(`The projects use different versions now: ${froms.join(", ")}.`);
    }

    if (target && isPrereleaseVersion(target)) {
        const fromStable = froms.some((from) => !isPrereleaseVersion(from));
        lines.push(fromStable
            ? `${target} is a prerelease. This moves a stable version to a prerelease.`
            : `${target} is a prerelease.`);
    }

    for (const advisory of input.advisories) {
        if (advisory.verdict === "closed") {
            lines.push(`Closes ${advisory.label}.`);
        } else if (advisory.verdict === "open") {
            lines.push(`${advisory.label} stays open in ${target ?? "the new version"}.`);
        } else {
            lines.push(`No local record says whether ${target ?? "the new version"} closes ${advisory.label}.`);
        }
    }

    const direct = input.projects.filter((project) => project.relation === "direct").map((project) => project.name);
    const transitive = input.projects.filter((project) => project.relation === "transitive").map((project) => project.name);
    if (direct.length > 0) {
        lines.push(`Direct reference in: ${direct.join(", ")}.`);
    }
    if (transitive.length > 0) {
        lines.push(`Transitive in: ${transitive.join(", ")}. A direct PackageReference will be added there to pin it.`);
    }

    if (input.centralFiles.length > 0) {
        lines.push(`Edits ${input.centralFiles.join(", ")}.`);
    } else if (input.usesCentralPackageManagement) {
        lines.push("Central Package Management is on. dotnet writes the version to Directory.Packages.props.");
    } else {
        lines.push("dotnet add package writes the version to the project files.");
    }

    if (input.youngerThanAgeGate && target) {
        lines.push(`${target} is younger than packageHub.minimumReleaseAge.`);
    }
    if (input.releaseAgeNotice) {
        lines.push(input.releaseAgeNotice);
    }

    return { heading, change, lines };
}
