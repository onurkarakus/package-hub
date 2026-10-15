import { compareNuGetVersions, sameNuGetVersion } from "../utils/nugetAudit";

export interface PackageLineFacts {
    version: string;
    latestVersion?: string;
    highestPatch?: string;
    severity?: string;
    projects?: string[];
    versionByProject?: Record<string, string>;
}

export interface PackageLineMark {
    kind: "vulnerable" | "outdated" | "deprecated";
    text: string;
    hover: string;
}

const WARNING = "\u26A0";
const CROSS = "\u2715";
const STOPPED = "\u2298";

export function packageLineFacts(
    pkg: PackageLineFacts | undefined,
    projectName: string | undefined
): PackageLineFacts | undefined {
    if (!pkg) {
        return undefined;
    }

    if (projectName) {
        const needle = projectName.toLowerCase();
        const names = pkg.projects || [];
        if (!names.some((name) => name.toLowerCase() === needle)) {
            return undefined;
        }
    }

    return {
        version: versionForProject(pkg.versionByProject, projectName) || pkg.version,
        latestVersion: pkg.latestVersion,
        highestPatch: pkg.highestPatch,
        severity: pkg.severity,
    };
}

function versionForProject(
    versions: Record<string, string> | undefined,
    projectName: string | undefined
): string | undefined {
    if (!versions || !projectName) {
        return undefined;
    }

    const needle = projectName.toLowerCase();
    for (const [name, version] of Object.entries(versions)) {
        if (name.toLowerCase() === needle && version) {
            return version;
        }
    }

    return undefined;
}

export function packageLineMark(
    lineVersion: string | undefined,
    facts: {
        vulnerable?: PackageLineFacts;
        outdated?: PackageLineFacts;
        deprecated?: PackageLineFacts;
    }
): PackageLineMark | undefined {
    const vulnerable = facts.vulnerable && versionApplies(lineVersion, facts.vulnerable.version)
        ? facts.vulnerable
        : undefined;
    const outdated = facts.outdated && versionApplies(lineVersion, facts.outdated.version)
        ? facts.outdated
        : undefined;
    const deprecated = facts.deprecated && versionApplies(lineVersion, facts.deprecated.version)
        ? facts.deprecated
        : undefined;

    if (vulnerable) {
        const newer = newerVersion(lineVersion || vulnerable.version, [
            outdated?.latestVersion,
            vulnerable.latestVersion,
            vulnerable.highestPatch,
            outdated?.highestPatch,
        ]);
        return {
            kind: "vulnerable",
            text: withVersion(WARNING, newer),
            hover: vulnerableHover(vulnerable.severity, newer),
        };
    }

    if (deprecated) {
        const newer = newerVersion(lineVersion || deprecated.version, [
            outdated?.latestVersion,
            deprecated.latestVersion,
            outdated?.highestPatch,
        ]);
        return {
            kind: "deprecated",
            text: withVersion(STOPPED, newer),
            hover: newer ? `Deprecated. Newer version ${newer}.` : "Deprecated.",
        };
    }

    if (!outdated) {
        return undefined;
    }

    const current = lineVersion || outdated.version;
    const newer = newerVersion(current, [outdated.latestVersion, outdated.highestPatch]);
    if ((outdated.latestVersion || outdated.highestPatch) && !newer) {
        return undefined;
    }

    return {
        kind: "outdated",
        text: withVersion(CROSS, newer),
        hover: newer ? `Outdated. Newer version ${newer}.` : "Outdated.",
    };
}

function versionApplies(lineVersion: string | undefined, scanned: string | undefined): boolean {
    if (!lineVersion || !scanned) {
        return true;
    }

    return sameNuGetVersion(lineVersion, scanned);
}

function newerVersion(current: string | undefined, candidates: (string | undefined)[]): string | undefined {
    for (const candidate of candidates) {
        if (!candidate) {
            continue;
        }

        if (!current || compareNuGetVersions(candidate, current) > 0) {
            return candidate;
        }
    }

    return undefined;
}

function withVersion(icon: string, version: string | undefined): string {
    return version ? `${icon} ${version}` : icon;
}

function vulnerableHover(severity: string | undefined, newer: string | undefined): string {
    const word = (severity || "").trim().toLowerCase();
    const head = word ? `Vulnerable, ${word} severity.` : "Vulnerable.";
    return newer ? `${head} Newer version ${newer}.` : head;
}
