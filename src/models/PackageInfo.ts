export interface PackageInfo {
    id: string;
    version: string;
    latestVersion?: string;
    highestPatch?: string;
    isVulnerable: boolean;
    isOutdated: boolean;
    isDeprecated: boolean;
    severity?: "Critical" | "High" | "Moderate" | "Low";
    advisoryUrl?: string;
    projects: string[];
    isTransitive: boolean;
    transitiveProjects?: string[];
    transitiveOrigins?: TransitiveOrigin[];
    isCentralPackageManagement?: boolean;
}

export interface TransitiveOrigin {
    project: string;
    broughtBy?: string;
    broughtByKind?: "package" | "project";
    absentFromGraph: boolean;
}