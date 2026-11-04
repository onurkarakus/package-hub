import * as path from "path";
import { PackageEntry, PackageInfo } from "../models/PackageInfo";
import { compareNuGetVersions, normalizeSeverity, severityRank } from "../utils/nugetAudit";
import { projectNameFromPath } from "./projectFiles";

export type PackageListKind = "vulnerable" | "outdated" | "deprecated" | "installed";

export interface DotnetProblem {
    level: string;
    text: string;
    project?: string;
}

export interface PackageListResult {
    packages: PackageInfo[];
    entries: PackageEntry[];
    /** Names of projects dotnet listed without an error. */
    projects: string[];
    /** Paths of projects dotnet listed without an error. */
    projectPaths: string[];
    /** Projects dotnet named in an error problem. They are not proven. */
    unreadableProjects: string[];
    problems: DotnetProblem[];
}

/**
 * dotnet could not read the target at all. The result must not be shown as
 * healthy.
 */
export class TargetUnreadableError extends Error {
    constructor(message: string, readonly problems: DotnetProblem[] = []) {
        super(message);
        this.name = "TargetUnreadableError";
    }
}

export function emptyPackageList(): PackageListResult {
    return { packages: [], entries: [], projects: [], projectPaths: [], unreadableProjects: [], problems: [] };
}

function samePath(left: string, right: string): boolean {
    const a = path.resolve(left);
    const b = path.resolve(right);
    return process.platform === "linux" ? a === b : a.toLowerCase() === b.toLowerCase();
}

/**
 * Reads `dotnet list package --format json` (or `dotnet package list`).
 *
 * Throws TargetUnreadableError when the text is not that JSON, or when dotnet
 * reports an error that is not tied to one project. A project named in an
 * error problem is listed in `unreadableProjects` and left out of `projects`.
 */
export function parsePackageListJson(
    jsonOutput: string,
    type: PackageListKind,
    baseDirectory?: string
): PackageListResult {
    const text = extractJson(jsonOutput);
    if (text === undefined) {
        throw new TargetUnreadableError("dotnet did not return package JSON.");
    }

    let data: any;
    try {
        data = JSON.parse(text);
    } catch (error: any) {
        throw new TargetUnreadableError(`dotnet returned JSON PackageHub could not read: ${error?.message || error}`);
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new TargetUnreadableError("dotnet returned JSON PackageHub could not read.");
    }

    const problems: DotnetProblem[] = (Array.isArray(data.problems) ? data.problems : [])
        .filter((item: any) => item && typeof item === "object")
        .map((item: any) => ({
            level: String(item.level || "").toLowerCase(),
            text: String(item.text || item.message || ""),
            project: typeof item.project === "string" ? item.project : undefined,
        }));
    const errors = problems.filter((problem) => problem.level === "error");
    const resolveProject = (value: string) =>
        baseDirectory && !path.isAbsolute(value) ? path.resolve(baseDirectory, value) : value;
    const unreadablePaths = errors
        .filter((problem) => problem.project)
        .map((problem) => resolveProject(problem.project as string));
    const targetErrors = errors.filter((problem) => !problem.project);

    if (targetErrors.length > 0) {
        throw new TargetUnreadableError(targetErrors.map((problem) => problem.text).join("\n"), problems);
    }

    if (!Array.isArray(data.projects)) {
        if (problems.length > 0 || data.version === undefined) {
            throw new TargetUnreadableError("dotnet listed no projects.", problems);
        }
    }

    const entries: PackageEntry[] = [];
    const seen = new Set<string>();
    const listedNames: string[] = [];
    const listedPaths: string[] = [];
    const unreadableNames: string[] = [];

    for (const project of Array.isArray(data.projects) ? data.projects : []) {
        const rawPath = String(project?.path || project?.projectPath || "");
        const projectPath = rawPath ? resolveProject(rawPath) : "";
        const projectName = projectPath ? projectNameFromPath(projectPath) : "Unknown";
        const unreadable = !!projectPath && unreadablePaths.some((item) => samePath(item, projectPath));
        if (unreadable) {
            if (!unreadableNames.includes(projectName)) {
                unreadableNames.push(projectName);
            }
            continue;
        }
        if (projectPath && !listedPaths.some((item) => samePath(item, projectPath))) {
            listedPaths.push(projectPath);
            if (!listedNames.some((item) => item.toLowerCase() === projectName.toLowerCase())) {
                listedNames.push(projectName);
            }
        }

        for (const framework of Array.isArray(project?.frameworks) ? project.frameworks : []) {
            const frameworkName = String(framework?.framework || "");
            const groups: [any[], boolean][] = [
                [Array.isArray(framework?.topLevelPackages) ? framework.topLevelPackages : [], false],
                [Array.isArray(framework?.transitivePackages) ? framework.transitivePackages : [], true],
            ];
            for (const [list, isTransitive] of groups) {
                if (type === "installed" && isTransitive) {
                    continue;
                }
                for (const pkg of list) {
                    const entry = readEntry(pkg, isTransitive, projectName, projectPath, frameworkName);
                    if (!entry) {
                        continue;
                    }
                    const key = [
                        entry.projectPath.toLowerCase(),
                        entry.framework.toLowerCase(),
                        entry.id.toLowerCase(),
                        entry.isTransitive ? "t" : "d",
                    ].join("\n");
                    if (seen.has(key)) {
                        continue;
                    }
                    seen.add(key);
                    entries.push(entry);
                }
            }
        }
    }

    for (const unreadablePath of unreadablePaths) {
        const name = projectNameFromPath(unreadablePath);
        if (!unreadableNames.includes(name)) {
            unreadableNames.push(name);
        }
    }

    return {
        packages: aggregatePackages(entries, type),
        entries,
        projects: listedNames,
        projectPaths: listedPaths,
        unreadableProjects: unreadableNames,
        problems,
    };
}

/**
 * dotnet can print text such as a first-run banner before the JSON. Returns the
 * JSON object, or undefined when there is none.
 */
export function extractJson(output: string): string | undefined {
    const text = (output || "").trim();
    if (!text) {
        return undefined;
    }
    if (text.startsWith("{")) {
        return text;
    }
    const start = text.indexOf("\n{");
    if (start < 0) {
        return undefined;
    }
    return text.slice(start + 1);
}

function readEntry(
    pkg: any,
    isTransitive: boolean,
    projectName: string,
    projectPath: string,
    framework: string
): PackageEntry | undefined {
    const id = typeof pkg?.id === "string" ? pkg.id : typeof pkg?.name === "string" ? pkg.name : "";
    const requestedVersion = typeof pkg?.requestedVersion === "string" ? pkg.requestedVersion : undefined;
    const resolvedVersion = typeof pkg?.resolvedVersion === "string"
        ? pkg.resolvedVersion
        : typeof pkg?.version === "string" ? pkg.version : undefined;
    if (!id || (!requestedVersion && !resolvedVersion)) {
        return undefined;
    }

    const entry: PackageEntry = {
        id,
        projectName,
        projectPath,
        framework,
        requestedVersion,
        resolvedVersion,
        isTransitive,
    };

    if (typeof pkg.latestVersion === "string" && pkg.latestVersion && !/not found/i.test(pkg.latestVersion)) {
        entry.latestVersion = pkg.latestVersion;
    }

    const vulnerabilities: any[] = Array.isArray(pkg.vulnerabilities) ? pkg.vulnerabilities : [];
    if (vulnerabilities.length > 0) {
        const sorted = [...vulnerabilities].sort(
            (a, b) => severityRank(String(b?.severity ?? "")) - severityRank(String(a?.severity ?? ""))
        );
        entry.severity = normalizeSeverity(sorted[0]?.severity);
        const urls = sorted
            .map((item) => item?.advisoryurl || item?.advisoryUrl || item?.url)
            .filter((url): url is string => typeof url === "string" && url.length > 0);
        entry.advisoryUrl = urls[0];
        entry.advisoryUrls = [...new Set(urls)];
    } else {
        entry.severity = normalizeSeverity(pkg.severity);
        const url = pkg.advisoryUrl || pkg.vulnerabilityUrl || pkg.advisoryurl;
        if (typeof url === "string" && url) {
            entry.advisoryUrl = url;
            entry.advisoryUrls = [url];
        }
    }

    if (Array.isArray(pkg.deprecationReasons)) {
        entry.deprecationReasons = pkg.deprecationReasons.filter((item: unknown) => typeof item === "string");
    }
    if (pkg.alternativePackage && typeof pkg.alternativePackage.id === "string") {
        entry.alternativePackage = pkg.alternativePackage.id;
    }

    return entry;
}

function pushUnique(list: string[], value: string): void {
    if (!list.some((item) => item.toLowerCase() === value.toLowerCase())) {
        list.push(value);
    }
}

/**
 * Builds one PackageInfo per package id from per-project entries. Versions are
 * kept per project, so a package with different versions in two projects is
 * not reduced to the first version.
 */
export function aggregatePackages(entries: PackageEntry[], type: PackageListKind): PackageInfo[] {
    const byId = new Map<string, PackageEntry[]>();
    for (const entry of entries) {
        const key = entry.id.toLowerCase();
        const list = byId.get(key) ?? [];
        list.push(entry);
        byId.set(key, list);
    }

    const result: PackageInfo[] = [];
    for (const list of byId.values()) {
        const direct = list.filter((entry) => !entry.isTransitive);
        const lead = direct[0] ?? list[0];
        const projects: string[] = [];
        const directProjects: string[] = [];
        const versionByProject: Record<string, string> = {};
        const requestedVersionByProject: Record<string, string> = {};
        const projectPaths: Record<string, string> = {};
        const advisoryUrls: string[] = [];
        let severity = lead.severity;
        let advisoryUrl = lead.advisoryUrl;
        let latestVersion: string | undefined;

        for (const entry of list) {
            pushUnique(projects, entry.projectName);
            if (!entry.isTransitive) {
                pushUnique(directProjects, entry.projectName);
            }
            if (entry.projectPath && !projectPaths[entry.projectName]) {
                projectPaths[entry.projectName] = entry.projectPath;
            }
            if (!entry.isTransitive && entry.requestedVersion && !requestedVersionByProject[entry.projectName]) {
                requestedVersionByProject[entry.projectName] = entry.requestedVersion;
            }
            for (const url of entry.advisoryUrls ?? (entry.advisoryUrl ? [entry.advisoryUrl] : [])) {
                if (!advisoryUrls.includes(url)) {
                    advisoryUrls.push(url);
                }
            }
            if (entry.severity && severityRank(entry.severity) > severityRank(severity)) {
                severity = entry.severity;
                advisoryUrl = entry.advisoryUrl;
            }
            if (entry.latestVersion) {
                if (!latestVersion || compareNuGetVersions(entry.latestVersion, latestVersion) > 0) {
                    latestVersion = entry.latestVersion;
                }
            }
        }

        for (const entry of [...direct, ...list.filter((item) => item.isTransitive)]) {
            const display = entry.resolvedVersion || entry.requestedVersion;
            if (display && !versionByProject[entry.projectName]) {
                versionByProject[entry.projectName] = display;
            }
        }

        const transitiveProjects = projects.filter(
            (name) => !directProjects.some((item) => item.toLowerCase() === name.toLowerCase())
        );
        const version = lead.resolvedVersion || lead.requestedVersion || "";

        const info: PackageInfo = {
            id: lead.id,
            version,
            requestedVersion: direct[0]?.requestedVersion,
            resolvedVersion: lead.resolvedVersion,
            latestVersion,
            isVulnerable: type === "vulnerable",
            isOutdated: type === "outdated",
            isDeprecated: type === "deprecated",
            severity,
            advisoryUrl,
            advisoryUrls,
            projects,
            directProjects,
            isTransitive: direct.length === 0,
            transitiveProjects,
            versionByProject,
            requestedVersionByProject,
            projectPaths,
            entries: list,
        };
        result.push(info);
    }

    return result;
}

/**
 * Finds packages whose resolved version differs between projects or target
 * frameworks.
 */
export function findVersionConflicts(entries: PackageEntry[]): {
    id: string;
    versions: { version: string; projects: string[] }[];
}[] {
    const byId = new Map<string, { id: string; versions: Map<string, string[]>; frameworksByProject: Map<string, Set<string>> }>();
    for (const entry of entries) {
        if (entry.isTransitive) {
            continue;
        }
        const version = entry.resolvedVersion || entry.requestedVersion;
        if (!version) {
            continue;
        }
        const key = entry.id.toLowerCase();
        const bucket = byId.get(key) ?? { id: entry.id, versions: new Map(), frameworksByProject: new Map() };
        byId.set(key, bucket);
        const frameworks = bucket.frameworksByProject.get(entry.projectName) ?? new Set<string>();
        frameworks.add(entry.framework);
        bucket.frameworksByProject.set(entry.projectName, frameworks);
        const normalized = [...bucket.versions.keys()].find((item) => compareNuGetVersions(item, version) === 0 || item === version)
            ?? version;
        const projects = bucket.versions.get(normalized) ?? [];
        const label = entry.framework ? `${entry.projectName} (${entry.framework})` : entry.projectName;
        if (!projects.includes(label)) {
            projects.push(label);
        }
        bucket.versions.set(normalized, projects);
    }

    const conflicts: { id: string; versions: { version: string; projects: string[] }[] }[] = [];
    for (const bucket of byId.values()) {
        if (bucket.versions.size < 2) {
            continue;
        }
        conflicts.push({
            id: bucket.id,
            versions: [...bucket.versions.entries()]
                .sort((left, right) => compareNuGetVersions(left[0], right[0]) || 0)
                .map(([version, labels]) => ({
                    version,
                    projects: labels.map((label) => {
                        const name = label.replace(/ \([^)]*\)$/, "");
                        const single = (bucket.frameworksByProject.get(name)?.size ?? 0) <= 1;
                        return single ? name : label;
                    }),
                })),
        });
    }
    return conflicts.sort((left, right) => left.id.localeCompare(right.id));
}
