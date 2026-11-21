import * as fs from "fs/promises";
import * as path from "path";
import { compareNuGetVersions, isComparableVersion, isPrereleaseVersion } from "../utils/nugetAudit";
import { parseNuspec } from "./PackageDetails";

/**
 * Finding packages to add. The local NuGet cache is read first and needs no
 * network. A feed search runs only when the user asks for one, through
 * `dotnet package search`, so dotnet uses the feeds and credentials from
 * NuGet.config as usual. PackageHub never reads or stores credentials.
 */

export interface SearchHit {
    id: string;
    /** Versions known for the package, newest first. */
    versions: string[];
    latestVersion?: string;
    description?: string;
    source: "local" | "feed";
    sourceName?: string;
    totalDownloads?: number;
}

const QUERY_PATTERN = /^[A-Za-z0-9_.\- ]{1,100}$/;

/** True for search text that is safe to pass to dotnet as one argument. */
export function isValidSearchQuery(value: unknown): value is string {
    return typeof value === "string"
        && QUERY_PATTERN.test(value)
        && value.trim().length > 0
        && !value.trim().startsWith("-");
}

export function sortVersionsDescending(versions: Iterable<string>): string[] {
    return [...new Set(versions)]
        .filter((version) => isComparableVersion(version))
        .sort((left, right) => compareNuGetVersions(right, left));
}

/** The newest stable version, or the newest prerelease when allowed and no stable one exists. */
export function newestVersion(versions: string[], includePrerelease = false): string | undefined {
    const sorted = sortVersionsDescending(versions);
    return sorted.find((version) => !isPrereleaseVersion(version))
        ?? (includePrerelease ? sorted[0] : undefined);
}

function rank(id: string, query: string): number {
    const lower = id.toLowerCase();
    if (lower === query) {
        return 0;
    }
    if (lower.startsWith(query)) {
        return 1;
    }
    if (lower.split(".").some((part) => part.startsWith(query))) {
        return 2;
    }
    return 3;
}

/**
 * Ranks package ids against a query: exact match first, then prefix, then
 * a dotted segment that starts with the query, then any substring.
 */
export function matchPackageIds(ids: string[], query: string, limit = 30): string[] {
    const needle = query.trim().toLowerCase();
    if (!needle) {
        return [];
    }
    const terms = needle.split(/\s+/);
    return ids
        .filter((id) => terms.every((term) => id.toLowerCase().includes(term)))
        .sort((left, right) => rank(left, needle) - rank(right, needle) || left.length - right.length || left.localeCompare(right))
        .slice(0, limit);
}

async function listDirectories(folder: string): Promise<string[]> {
    try {
        const entries = await fs.readdir(folder, { withFileTypes: true });
        return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
        return [];
    }
}

let idCache: { root: string; at: number; ids: string[] } | undefined;

async function cachedIds(root: string): Promise<string[]> {
    if (idCache && idCache.root === root && Date.now() - idCache.at < 30000) {
        return idCache.ids;
    }
    const ids = await listDirectories(root);
    idCache = { root, at: Date.now(), ids };
    return ids;
}

/**
 * Searches the global packages folder (for example ~/.nuget/packages). Only
 * versions with a .nuspec are listed, so half-extracted folders are skipped.
 */
export async function searchLocalPackages(root: string, query: string, limit = 30): Promise<SearchHit[]> {
    const ids = matchPackageIds(await cachedIds(root), query, limit);
    const hits: SearchHit[] = [];
    for (const folderId of ids) {
        const versions: string[] = [];
        for (const version of await listDirectories(path.join(root, folderId))) {
            try {
                await fs.access(path.join(root, folderId, version, `${folderId}.nuspec`));
                versions.push(version);
            } catch {
                continue;
            }
        }
        const sorted = sortVersionsDescending(versions);
        if (sorted.length === 0) {
            continue;
        }
        let id = folderId;
        let description: string | undefined;
        try {
            const nuspec = parseNuspec(await fs.readFile(path.join(root, folderId, sorted[0], `${folderId}.nuspec`), "utf8"));
            id = nuspec?.id ?? folderId;
            description = nuspec?.description;
        } catch {
            // The folder name is the id in lower case; keep it.
        }
        hits.push({ id, versions: sorted, latestVersion: sorted[0], description, source: "local" });
    }
    return hits;
}

/**
 * Reads `dotnet package search <query> --format json`. Results from several
 * sources are merged by id; the first source wins for the description.
 */
export function parseSearchResults(json: string): { hits: SearchHit[]; problems: string[] } {
    const data = JSON.parse(json);
    const problems: string[] = [];
    for (const problem of Array.isArray(data?.problems) ? data.problems : []) {
        const text = typeof problem === "string" ? problem : problem?.text ?? problem?.message;
        if (typeof text === "string" && text.trim()) {
            problems.push(text.trim());
        }
    }
    const byId = new Map<string, SearchHit>();
    for (const source of Array.isArray(data?.searchResult) ? data.searchResult : []) {
        const sourceName = typeof source?.sourceName === "string" ? source.sourceName : undefined;
        if (typeof source?.problems === "object" && Array.isArray(source.problems)) {
            for (const problem of source.problems) {
                const text = typeof problem === "string" ? problem : problem?.text ?? problem?.message;
                if (typeof text === "string" && text.trim()) {
                    problems.push(sourceName ? `${sourceName}: ${text.trim()}` : text.trim());
                }
            }
        }
        for (const pkg of Array.isArray(source?.packages) ? source.packages : []) {
            if (typeof pkg?.id !== "string") {
                continue;
            }
            const version = typeof pkg.latestVersion === "string" ? pkg.latestVersion : typeof pkg.version === "string" ? pkg.version : undefined;
            const key = pkg.id.toLowerCase();
            const known = byId.get(key);
            if (known) {
                if (version && !known.versions.includes(version)) {
                    known.versions = sortVersionsDescending([...known.versions, version]);
                    known.latestVersion = known.versions[0];
                }
                continue;
            }
            byId.set(key, {
                id: pkg.id,
                versions: version ? [version] : [],
                latestVersion: version,
                description: typeof pkg.description === "string" ? pkg.description : undefined,
                source: "feed",
                sourceName,
                totalDownloads: typeof pkg.totalDownloads === "number" ? pkg.totalDownloads : undefined,
            });
        }
    }
    return { hits: [...byId.values()], problems };
}

/**
 * Reads `dotnet package search <id> --exact-match --format json`: every
 * version of one package across the sources, newest first.
 */
export function parseExactVersions(json: string, packageId: string): string[] {
    const data = JSON.parse(json);
    const versions: string[] = [];
    for (const source of Array.isArray(data?.searchResult) ? data.searchResult : []) {
        for (const pkg of Array.isArray(source?.packages) ? source.packages : []) {
            if (typeof pkg?.id === "string" && pkg.id.toLowerCase() === packageId.toLowerCase()) {
                const version = typeof pkg.version === "string" ? pkg.version : pkg.latestVersion;
                if (typeof version === "string") {
                    versions.push(version);
                }
            }
        }
    }
    return sortVersionsDescending(versions);
}

/**
 * Merges local and feed hits. Local versions stay, feed versions are added.
 */
export function mergeHits(local: SearchHit[], feed: SearchHit[]): SearchHit[] {
    const byId = new Map<string, SearchHit>();
    for (const hit of [...local, ...feed]) {
        const key = hit.id.toLowerCase();
        const known = byId.get(key);
        if (!known) {
            byId.set(key, { ...hit, versions: [...hit.versions] });
            continue;
        }
        known.versions = sortVersionsDescending([...known.versions, ...hit.versions]);
        known.latestVersion = known.versions[0];
        known.description = known.description ?? hit.description;
        known.totalDownloads = known.totalDownloads ?? hit.totalDownloads;
        known.sourceName = known.sourceName ?? hit.sourceName;
    }
    return [...byId.values()];
}
