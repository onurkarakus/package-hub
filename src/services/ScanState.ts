import * as vscode from "vscode";
import { PackageInfo } from "../models/PackageInfo";
import { meetsMinimumSeverity } from "../utils/nugetAudit";

export interface PackageSourceState {
    found: boolean;
    unreadable: boolean;
    names: string[];
}

export class ScanState {
    private static vulnerable: PackageInfo[] = [];
    private static outdated: PackageInfo[] = [];
    private static deprecated: PackageInfo[] = [];
    private static scannedAt: Date | undefined;
    private static hasCpm = false;
    private static centralVersions = new Map<string, string>();
    private static packageSources: PackageSourceState | undefined;
    private static auditDataGap = false;

    static setCpm(hasCpm: boolean) {
        this.hasCpm = hasCpm;
    }

    static getCpm(): boolean {
        return this.hasCpm;
    }

    static setPackageSources(sources: PackageSourceState) {
        this.packageSources = sources;
    }

    static getPackageSources(): PackageSourceState | undefined {
        return this.packageSources;
    }

    static setAuditDataGap(value: boolean) {
        this.auditDataGap = value;
    }

    static hasAuditDataGap(): boolean {
        return this.auditDataGap;
    }

    static statusBarLabel(): { healthy: boolean; text: string } {
        const vulnerable = this.getVulnerable().length;
        const outdated = this.getOutDated().length;
        const deprecated = this.getDeprecated().length;
        const healthy = vulnerable + outdated + deprecated === 0 && !this.auditDataGap;
        if (healthy) {
            return { healthy: true, text: "$(check) Packages healthy" };
        }
        if (vulnerable + outdated + deprecated === 0) {
            return { healthy: false, text: "$(warning) Audit source" };
        }
        return {
            healthy: false,
            text: `$(warning) ${vulnerable} vuln · ${outdated} outdated · ${deprecated} deprecated`,
        };
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

    static includePrerelease(): boolean {
        return vscode.workspace.getConfiguration("packageHub").get<boolean>("includePrerelease") === true;
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

    static getAllVulnerable(): PackageInfo[] {
        return this.vulnerable;
    }

    static getVulnerable(): PackageInfo[] {
        const minimum = vscode.workspace.getConfiguration("packageHub").get<string>("minimumSeverity") || "low";
        return this.vulnerable.filter((pkg) => meetsMinimumSeverity(pkg.severity, minimum));
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
        const vulnerable = this.vulnerable.find((p) => p.id.toLowerCase() === id);
        const minimum = vscode.workspace.getConfiguration("packageHub").get<string>("minimumSeverity") || "low";

        return {
            vulnerable: vulnerable && meetsMinimumSeverity(vulnerable.severity, minimum) ? vulnerable : undefined,
            outdated: this.outdated.find((p) => p.id.toLowerCase() === id),
            deprecated: this.deprecated.find((p) => p.id.toLowerCase() === id),
        };
    }

    static getVersionConflicts(): {
        id: string;
        versions: { version: string; projects: string[] }[];
    }[] {
        const all = [...this.getVulnerable(), ...this.outdated, ...this.deprecated];
        const byId = new Map<string, { id: string; versions: Map<string, string[]> }>();

        for (const p of all) {
            const key = p.id.toLowerCase();
            if (!byId.has(key)) {
                byId.set(key, { id: p.id, versions: new Map() });
            }

            const versions = byId.get(key)!.versions;
            const versionByProject: Record<string, string> =
                (p as { versionByProject?: Record<string, string> }).versionByProject || {};

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

        for (const bucket of byId.values()) {
            if (bucket.versions.size > 1) {
                conflicts.push({
                    id: bucket.id,
                    versions: Array.from(bucket.versions.entries()).map(([version, projects]) => ({
                        version,
                        projects,
                    })),
                });
            }
        }

        return conflicts;
    }
}