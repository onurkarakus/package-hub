import * as vscode from "vscode";
import { PackageEntry, PackageInfo } from "../models/PackageInfo";
import { meetsMinimumSeverity } from "../utils/nugetAudit";
import { findVersionConflicts } from "./PackageList";

export interface PackageSourceState {
    found: boolean;
    unreadable: boolean;
    names: string[];
}

export class ScanState {
    private static vulnerable: PackageInfo[] = [];
    private static outdated: PackageInfo[] = [];
    private static deprecated: PackageInfo[] = [];
    private static installed: PackageInfo[] = [];
    private static provenProjects: string[] = [];
    private static unreadableProjects: string[] = [];
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

    /**
     * True when the last scan read at least one project. A folder with no
     * .NET project, or a scan that could not read any, is not "healthy".
     */
    static scannedAnything(): boolean {
        return !!this.scannedAt && (this.provenProjects.length > 0 || this.installed.length > 0);
    }

    static statusBarLabel(): { healthy: boolean; text: string; neutral?: boolean } {
        const vulnerable = this.getVulnerable().length;
        const outdated = this.getOutDated().length;
        const deprecated = this.getDeprecated().length;
        const unreadable = this.getUnreadableProjects().length;
        const healthy = vulnerable + outdated + deprecated === 0 && !this.auditDataGap && unreadable === 0;
        if (healthy && !this.scannedAnything()) {
            return { healthy: true, text: "$(package) PackageHub", neutral: true };
        }
        if (healthy) {
            return { healthy: true, text: "$(check) Packages healthy" };
        }
        if (vulnerable + outdated + deprecated === 0) {
            return unreadable > 0
                ? { healthy: false, text: `$(warning) ${unreadable} project${unreadable === 1 ? "" : "s"} not checked` }
                : { healthy: false, text: "$(warning) Audit source" };
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
        scannedAt?: Date,
        installed: PackageInfo[] = [],
        provenProjects: string[] = []
    ) {
        this.vulnerable = vulnerable;
        this.outdated = outdated;
        this.deprecated = deprecated;
        this.installed = installed;
        this.provenProjects = provenProjects;
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

    static getInstalled(): PackageInfo[] {
        return this.installed;
    }

    static getProvenProjects(): string[] {
        return this.provenProjects;
    }

    static isProjectProven(projectName: string): boolean {
        const needle = projectName.toLowerCase();
        return this.provenProjects.some((name) => name.toLowerCase() === needle);
    }

    static findInstalled(packageId: string): PackageInfo | undefined {
        const id = packageId.toLowerCase();
        return this.installed.find((pkg) => pkg.id.toLowerCase() === id);
    }

    static getScannedAt(): Date | undefined {
        return this.scannedAt;
    }

    static findPackage(packageId: string): {
        vulnerable?: PackageInfo;
        outdated?: PackageInfo;
        deprecated?: PackageInfo
    } {
        const id = packageId.toLowerCase();
        const vulnerable = this.vulnerable.find((p) => p.id.toLowerCase() === id);
        const minimum = vscode.workspace.getConfiguration("packageHub").get<string>("minimumSeverity") || "low";

        return {
            vulnerable: vulnerable && meetsMinimumSeverity(vulnerable.severity, minimum) ? vulnerable : undefined,
            outdated: this.outdated.find((p) => p.id.toLowerCase() === id),
            deprecated: this.deprecated.find((p) => p.id.toLowerCase() === id),
        };
    }

    static setUnreadableProjects(names: string[]) {
        this.unreadableProjects = [...names];
    }

    static getUnreadableProjects(): string[] {
        return this.unreadableProjects;
    }

    /**
     * Every per-project entry from the last scan: installed (direct) packages
     * and the vulnerable, outdated and deprecated lists.
     */
    static allEntries(): PackageEntry[] {
        const result: PackageEntry[] = [];
        const seen = new Set<string>();
        for (const pkg of [...this.installed, ...this.vulnerable, ...this.outdated, ...this.deprecated]) {
            for (const entry of pkg.entries || []) {
                const key = [entry.projectPath, entry.framework, entry.id, entry.isTransitive ? "t" : "d"]
                    .join("\n").toLowerCase();
                if (!seen.has(key)) {
                    seen.add(key);
                    result.push(entry);
                }
            }
        }
        return result;
    }

    /**
     * The resolved version of a package in one project, when the scan saw it.
     */
    static resolvedVersionIn(packageId: string, projectName: string | undefined): string | undefined {
        if (!projectName) {
            return undefined;
        }
        const id = packageId.toLowerCase();
        const name = projectName.toLowerCase();
        for (const pkg of [this.installed, this.vulnerable, this.outdated, this.deprecated]
            .map((list) => list.find((item) => item.id.toLowerCase() === id))) {
            if (!pkg?.versionByProject) {
                continue;
            }
            for (const [project, version] of Object.entries(pkg.versionByProject)) {
                if (project.toLowerCase() === name && version) {
                    return version;
                }
            }
        }
        return undefined;
    }

    /**
     * Packages whose resolved version differs between projects or target
     * frameworks. Read per project, so the first project's version does not
     * hide the others.
     */
    static getVersionConflicts(): {
        id: string;
        versions: { version: string; projects: string[] }[];
    }[] {
        const entries = this.allEntries();
        if (entries.length > 0) {
            return findVersionConflicts(entries);
        }

        // A scan saved by 0.0.x has no entries. Fall back to the per-project map.
        const all = [...this.installed, ...this.getVulnerable(), ...this.outdated, ...this.deprecated];
        const fallback: PackageEntry[] = [];
        for (const p of all) {
            const versions = p.versionByProject || {};
            const pairs = Object.keys(versions).length > 0
                ? Object.entries(versions)
                : (p.projects || []).map((project) => [project, p.version] as [string, string]);
            for (const [project, version] of pairs) {
                fallback.push({
                    id: p.id,
                    projectName: project,
                    projectPath: project,
                    framework: "",
                    resolvedVersion: version,
                    isTransitive: false,
                });
            }
        }
        return findVersionConflicts(fallback);
    }
}
