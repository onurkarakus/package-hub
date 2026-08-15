import { PackageInfo } from "../models/PackageInfo";

export interface ExplanationResult {
    title: string;
    severity?: string;
    reason: string;
    recommendedVersion?: string;
    advisoryUrl?: string;
    isVulnerable: boolean;
    isOutdated: boolean;
}

export class WarningExplainer {
    static explain(
        packageId: string,
        currentVersion: string,
        vulnerable?: PackageInfo,
        outdated?: PackageInfo
    ): ExplanationResult {
        if (vulnerable) {
            return {
                title: packageId,
                severity: vulnerable.severity || "Unknown",
                reason: `Known ${vulnerable.severity || ""} severity vulnerability`.trim(),
                recommendedVersion: vulnerable.latestVersion,
                advisoryUrl: vulnerable.advisoryUrl,
                isVulnerable: true,
                isOutdated: false,
            };
        }

        if (outdated) {
            return {
                title: packageId,
                reason: "A newer version is available",
                recommendedVersion: outdated.latestVersion,
                isVulnerable: false,
                isOutdated: true,
            };
        }

        return {
            title: packageId,
            reason: "No known issues found in the last scan",
            isVulnerable: false,
            isOutdated: false,
        };
    }
}