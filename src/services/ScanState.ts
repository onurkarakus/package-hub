import { PackageInfo } from "../models/PackageInfo";

export class ScanState {
    private static vulnerable: PackageInfo[] = [];
    private static outdated: PackageInfo[] = [];
    private static deprecated: PackageInfo[] = [];
    private static scannedAt: Date | undefined;
    private static hasCpm = false;
    private static centralVersions = new Map<string, string>();

    static setCpm(hasCpm: boolean) {
        this.hasCpm = hasCpm;
    }

    static getCpm(): boolean {
        return this.hasCpm;
    }

    static setCentralVersions(versions: { id: string; version: string }[]) {
        this.centralVersions = new Map(
            versions.map((item) => [item.id.toLowerCase(), item.version])
        );
    }

    static getCentralVersion(packageId: string): string | undefined {
        return this.centralVersions.get(packageId.toLowerCase());
    }

    static getCentralVersionCount(): number {
        return this.centralVersions.size;
    }

    static setResults(
        vulnerable: PackageInfo[],
        outdated: PackageInfo[],
        deprecated: PackageInfo[] = [],
        scannedAt?: Date
    ) {
        this.vulnerable = vulnerable;
        this.outdated = outdated;
        this.deprecated = deprecated;
        this.scannedAt = scannedAt ?? new Date();
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

    static getVersionConflicts(): {
        id: string;
        versions: { version: string; projects: string[] }[];
    }[] {
        const all = [...this.vulnerable, ...this.outdated, ...this.deprecated];
        const byId = new Map<string, Map<string, string[]>>();

        for (const p of all as any[]) {
            const key = p.id.toLowerCase();
            if (!byId.has(key)) {
                byId.set(key, new Map());
            }

            const versions = byId.get(key)!;
            const versionByProject: Record<string, string> = p.versionByProject || {};

            const entries =
                Object.keys(versionByProject).length > 0
                    ? Object.entries(versionByProject)
                    : (p.projects || []).map((proj: string) => [proj, p.version]);

            for (const [proj, version] of entries) {
                if (!versions.has(version)) {
                    versions.set(version, []);
                }
                if (!versions.get(version)!.includes(proj)) {
                    versions.get(version)!.push(proj);
                }
            }
        }

        const conflicts = [];

        for (const [id, versions] of byId) {
            if (versions.size > 1) {
                conflicts.push({
                    id,
                    versions: Array.from(versions.entries()).map(([version, projects]) => ({
                        version,
                        projects,
                    })),
                });
            }
        }

        return conflicts;
    }
}