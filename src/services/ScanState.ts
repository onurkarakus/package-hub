import { PackageInfo } from "../models/PackageInfo";

export class ScanState {
    private static vulnerable: PackageInfo[] = [];
    private static outdated: PackageInfo[] = [];

    static setResults(vulnerable: PackageInfo[], outdated: PackageInfo[]) {
        this.vulnerable = vulnerable;
        this.outdated = outdated;
    }

    static getVulnerable(): PackageInfo[] {
        return this.vulnerable;
    }

    static getOutDated(): PackageInfo[] {
        return this.outdated;
    }

    static findPackage(packageId: string): {
        vulnerable?: PackageInfo;
        outdated?: PackageInfo;
    } {
        const vulnerable = this.vulnerable.find((p) => p.id.toLocaleLowerCase() === packageId.toLowerCase());
        const outdated = this.outdated.find((p) => p.id.toLowerCase() === packageId.toLocaleLowerCase());

        return { vulnerable, outdated };
    }
}