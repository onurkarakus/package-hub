import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { normalizeSeverity, Severity } from "../utils/nugetAudit";

/**
 * Reads data that dotnet and NuGet already wrote to the local HTTP cache.
 * Nothing here makes a network request.
 *
 * Layout (one folder per package source):
 *   <http-cache>/<hash>$<source>/vuln_data_base.dat     NuGet audit data
 *   <http-cache>/<hash>$<source>/vuln_data_update.dat
 *   <http-cache>/<hash>$<source>/list_<id>_index.dat    registration index
 *   <http-cache>/<hash>$<source>/list_<id>_range_*.dat  registration pages
 */

export interface LocalAdvisory {
    packageId: string;
    url: string;
    versions: string;
    severity?: Severity;
}

export function defaultHttpCachePath(
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
    home = os.homedir()
): string {
    if (env.NUGET_HTTP_CACHE_PATH) {
        return env.NUGET_HTTP_CACHE_PATH;
    }
    if (platform === "win32") {
        const local = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
        return path.join(local, "NuGet", "v3-cache");
    }
    return path.join(home, ".local", "share", "NuGet", "http-cache");
}

async function sourceFolders(root: string): Promise<string[]> {
    try {
        const entries = await fs.readdir(root, { withFileTypes: true });
        return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
    } catch {
        return [];
    }
}

async function readJsonFile(filePath: string): Promise<unknown> {
    let text: string;
    try {
        text = await fs.readFile(filePath, "utf8");
    } catch {
        return undefined;
    }
    const start = text.search(/[[{]/);
    if (start < 0) {
        return undefined;
    }
    try {
        return JSON.parse(text.slice(start));
    } catch {
        return undefined;
    }
}

/**
 * Reads one NuGet vulnerability file: { "<id>": [{ url, severity, versions }] }.
 */
export function parseVulnerabilityData(data: unknown): LocalAdvisory[] {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        return [];
    }
    const result: LocalAdvisory[] = [];
    for (const [packageId, items] of Object.entries(data as Record<string, unknown>)) {
        if (!Array.isArray(items)) {
            continue;
        }
        for (const item of items) {
            if (item && typeof item.url === "string" && typeof item.versions === "string") {
                result.push({
                    packageId,
                    url: item.url,
                    versions: item.versions,
                    severity: normalizeSeverity(item.severity),
                });
            }
        }
    }
    return result;
}

/**
 * Reads the vulnerability data NuGet audit downloaded during restore. Returns
 * an empty list when restore has not cached any.
 */
export async function readLocalVulnerabilities(cacheRoot: string): Promise<LocalAdvisory[]> {
    const seen = new Set<string>();
    const result: LocalAdvisory[] = [];
    for (const folder of await sourceFolders(cacheRoot)) {
        for (const name of ["vuln_data_base.dat", "vuln_data_update.dat"]) {
            for (const advisory of parseVulnerabilityData(await readJsonFile(path.join(folder, name)))) {
                const key = `${advisory.packageId.toLowerCase()}\n${advisory.url.toLowerCase()}\n${advisory.versions}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    result.push(advisory);
                }
            }
        }
    }
    return result;
}

function readPublished(value: unknown): Date | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const date = new Date(value);
    // Unlisted packages carry 1900-01-01.
    if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 2000) {
        return undefined;
    }
    return date;
}

function normalizeVersionKey(version: string): string {
    return version.trim().toLowerCase().replace(/\+.*$/, "");
}

/**
 * Reads `published` dates from a registration index or page.
 */
export function parseRegistrationPublished(data: unknown, into = new Map<string, Date>()): Map<string, Date> {
    const visit = (node: any) => {
        if (!node || typeof node !== "object") {
            return;
        }
        const entry = node.catalogEntry;
        if (entry && typeof entry === "object" && typeof entry.version === "string") {
            const published = readPublished(entry.published);
            if (published) {
                into.set(normalizeVersionKey(entry.version), published);
            }
        }
        if (Array.isArray(node.items)) {
            for (const child of node.items) {
                visit(child);
            }
        }
    };
    visit(data);
    return into;
}

function cacheFileId(packageId: string): string {
    return packageId.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "_");
}

/**
 * Reads the publish dates of a package from registration data dotnet cached
 * while it listed outdated packages.
 */
export async function readLocalPublishedDates(cacheRoot: string, packageId: string): Promise<Map<string, Date>> {
    const id = cacheFileId(packageId);
    const dates = new Map<string, Date>();
    for (const folder of await sourceFolders(cacheRoot)) {
        let names: string[] = [];
        try {
            names = await fs.readdir(folder);
        } catch {
            continue;
        }
        const wanted = names.filter((name) =>
            name === `list_${id}_index.dat` || (name.startsWith(`list_${id}_range_`) && name.endsWith(".dat"))
        );
        for (const name of wanted) {
            parseRegistrationPublished(await readJsonFile(path.join(folder, name)), dates);
        }
    }
    return dates;
}

export function publishedFrom(dates: Map<string, Date>, version: string): Date | undefined {
    return dates.get(normalizeVersionKey(version));
}

let knownCacheRoot: string | undefined;

export function setHttpCacheRoot(root: string | undefined): void {
    knownCacheRoot = root;
}

export function getHttpCacheRoot(): string | undefined {
    return knownCacheRoot;
}

/**
 * Reads the version list (flat container index) dotnet cached for a package.
 */
export async function readLocalVersions(cacheRoot: string, packageId: string): Promise<string[]> {
    const id = cacheFileId(packageId);
    const versions = new Set<string>();
    for (const folder of await sourceFolders(cacheRoot)) {
        const data = await readJsonFile(path.join(folder, `list_${id}.dat`)) as { versions?: unknown } | undefined;
        if (data && Array.isArray(data.versions)) {
            for (const version of data.versions) {
                if (typeof version === "string") {
                    versions.add(version);
                }
            }
        }
        const dates = parseRegistrationPublished(await readJsonFile(path.join(folder, `list_${id}_index.dat`)));
        for (const version of dates.keys()) {
            versions.add(version);
        }
    }
    return [...versions];
}
