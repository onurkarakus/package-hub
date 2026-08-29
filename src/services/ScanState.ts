import { PackageInfo } from "../models/PackageInfo";

export class ScanState {
    private static vulnerable: PackageInfo[] = [];
    private static outdated: PackageInfo[] = [];
    private static deprecated: PackageInfo[] = [];
    private static scannedAt: Date | undefined;

    static setResults(
        vulnerable: PackageInfo[],
        outdated: PackageInfo[],
        deprecated: PackageInfo[] = []) {
        this.vulnerable = vulnerable;
        this.outdated = outdated;
        this.deprecated = deprecated;
        this.scannedAt = new Date();
    }

    static getVulnerable(): PackageInfo[] {
        return this.vulnerable;
    }

    static getOutDated(): PackageInfo[] {
        return this.outdated;
    }
    static getDeprecated(): PackageInfo[] {
        return this.deprecated;
    }

    static getScannedAt(): Date | undefined {
        return this.scannedAt;
    }

    static findPackage(packageId: string): {
        vulnerable?: PackageInfo;
        outdated?: PackageInfo;
        deprecated?: PackageInfo
    } {
        const id = packageId.toLocaleLowerCase();

        return {
            vulnerable: this.vulnerable.find((p) => p.id.toLowerCase() === id),
            outdated: this.outdated.find((p) => p.id.toLowerCase() === id),
            deprecated: this.deprecated.find((p) => p.id.toLowerCase() === id),
        };
    }
}