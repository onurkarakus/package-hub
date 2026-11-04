import { Severity } from "../utils/nugetAudit";

/**
 * One package in one project and one target framework, as dotnet listed it.
 */
export interface PackageEntry {
    id: string;
    projectName: string;
    projectPath: string;
    framework: string;
    /** The version or range written in the project (for edits). */
    requestedVersion?: string;
    /** The version restore picked (for display and vulnerability checks). */
    resolvedVersion?: string;
    latestVersion?: string;
    isTransitive: boolean;
    severity?: Severity;
    advisoryUrl?: string;
    advisoryUrls?: string[];
    deprecationReasons?: string[];
    alternativePackage?: string;
}

export interface PackageInfo {
    id: string;
    /** Display version: the resolved version from the first entry. */
    version: string;
    requestedVersion?: string;
    resolvedVersion?: string;
    latestVersion?: string;
    highestPatch?: string;
    isVulnerable: boolean;
    isOutdated: boolean;
    isDeprecated: boolean;
    severity?: Severity;
    advisoryUrl?: string;
    advisoryUrls?: string[];
    projects: string[];
    /** Projects that reference the package directly. */
    directProjects?: string[];
    isTransitive: boolean;
    transitiveProjects?: string[];
    transitiveOrigins?: TransitiveOrigin[];
    isCentralPackageManagement?: boolean;
    /** Resolved version per project name. */
    versionByProject?: Record<string, string>;
    /** Requested version per project name. Missing for transitive packages. */
    requestedVersionByProject?: Record<string, string>;
    /** Project file path per project name. */
    projectPaths?: Record<string, string>;
    /** Every entry this package was built from. */
    entries?: PackageEntry[];
}

export interface TransitiveOrigin {
    project: string;
    broughtBy?: string;
    broughtByKind?: "package" | "project";
    absentFromGraph: boolean;
}
