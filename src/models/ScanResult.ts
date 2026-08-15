import { PackageInfo } from "./PackageInfo";
import { ProjectInfo } from "./ProjectInfo";

export interface ScanResult {
    vulnerable: PackageInfo[];
    outdated: PackageInfo[];
    deprecated: PackageInfo[];
    healthyCount: number;
    scannedAt: Date;
    projects: ProjectInfo[];
}