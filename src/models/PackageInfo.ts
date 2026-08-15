export interface PackageInfo {
    id: string;
    version: string;
    latestVersion?: string;
    isVulnerable: boolean;
    isOutdated: boolean;
    isDeprecated: boolean;
    severity?: "Critical" | "High" | "Moderate" | "Low";
    advisoryUrl?: string;
    projects: string[];
    isTransitive: boolean;
    isCentralPackageManagement?: boolean;
}