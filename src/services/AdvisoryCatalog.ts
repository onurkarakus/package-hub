import { firstFixedFromRanges, versionInsideRange } from "../utils/nugetAudit";
import { parseVulnerabilityData, readLocalVulnerabilities } from "./NuGetLocalCache";
import { fetchOnlineJson } from "./OnlineFetch";

export type AdvisoryVerdict = "open" | "closed" | "unknown";

interface AdvisoryRecord {
    url: string;
    versions: string;
}

const records = new Map<string, AdvisoryRecord[]>();
let ready = false;
let pending: Promise<void> | undefined;

const SERVICE_INDEX = "https://api.nuget.org/v3/index.json";

export function advisoryVerdict(
    packageId: string | undefined,
    advisoryUrl: string | undefined,
    version: string | undefined
): AdvisoryVerdict {
    if (!ready || !packageId || !advisoryUrl || !version) {
        return "unknown";
    }

    const list = records.get(packageId.toLowerCase());
    if (!list || list.length === 0) {
        return "unknown";
    }

    const key = advisoryKey(advisoryUrl);
    const matched = list.filter((item) => advisoryKey(item.url) === key);
    if (matched.length === 0) {
        return "unknown";
    }

    let parsed = false;
    for (const item of matched) {
        const inside = versionInsideRange(version, item.versions);
        if (inside === undefined) {
            return "unknown";
        }
        parsed = true;
        if (inside) {
            return "open";
        }
    }

    return parsed ? "closed" : "unknown";
}

export function firstFixedVersion(
    packageId: string | undefined,
    advisoryUrl: string | undefined,
    current: string | undefined
): string | undefined {
    if (!ready || !packageId || !advisoryUrl) {
        return undefined;
    }

    const list = records.get(packageId.toLowerCase());
    if (!list || list.length === 0) {
        return undefined;
    }

    const key = advisoryKey(advisoryUrl);
    const matched = list.filter((item) => advisoryKey(item.url) === key);
    if (matched.length === 0) {
        return undefined;
    }

    const named = firstFixedFromRanges(matched.map((item) => item.versions), current);
    if (!named || advisoryVerdict(packageId, advisoryUrl, named) !== "closed") {
        return undefined;
    }

    return named;
}

export function advisoryLabel(advisoryUrl: string | undefined): string {
    const match = advisoryUrl?.match(/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i);
    return match ? match[0] : "this advisory";
}

export function replaceAdvisoryRecords(
    entries: { packageId: string; url: string; versions: string }[]
): void {
    records.clear();
    for (const entry of entries) {
        const key = entry.packageId.toLowerCase();
        const list = records.get(key) ?? [];
        list.push({ url: entry.url, versions: entry.versions });
        records.set(key, list);
    }
    ready = true;
}

export function clearAdvisoryRecords(): void {
    records.clear();
    ready = false;
    pending = undefined;
    catalogSource = undefined;
}

export type AdvisoryCatalogSource = "local" | "online";
let catalogSource: AdvisoryCatalogSource | undefined;

export function advisoryCatalogSource(): AdvisoryCatalogSource | undefined {
    return ready ? catalogSource : undefined;
}

export interface AdvisoryCatalogOptions {
    /** The NuGet HTTP cache folder. */
    cacheRoot?: string;
    /** packageHub.onlineLookups. */
    online: boolean;
}

/**
 * Loads advisory ranges.
 *
 * Local first: the vulnerability data NuGet audit downloaded during restore
 * and keeps in its HTTP cache. Only when that is missing and
 * packageHub.onlineLookups is on does PackageHub download the same data from
 * nuget.org itself.
 */
export function loadAdvisoryCatalog(options: AdvisoryCatalogOptions): Promise<void> {
    if (!pending) {
        pending = loadCatalog(options)
            .catch((error) => {
                pending = undefined;
                ready = false;
                throw error;
            });
    }

    return pending;
}

/**
 * Reads the catalog again, for example after a scan restored packages.
 * The old records stay usable until the new ones are in.
 */
export function refreshAdvisoryCatalog(options: AdvisoryCatalogOptions): Promise<void> {
    pending = undefined;
    return loadAdvisoryCatalog(options);
}

async function loadCatalog(options: AdvisoryCatalogOptions): Promise<void> {
    const local = options.cacheRoot ? await readLocalVulnerabilities(options.cacheRoot) : [];
    if (local.length > 0) {
        replaceAdvisoryRecords(local);
        catalogSource = "local";
        return;
    }

    if (!options.online) {
        throw new Error("No NuGet audit data in the local cache yet. Run a restore with NuGetAudit on, or turn on packageHub.onlineLookups.");
    }

    const fetched = await fetchCatalog();
    replaceAdvisoryRecords(fetched);
    catalogSource = "online";
}

/**
 * Opt-in only (packageHub.onlineLookups).
 */
async function fetchCatalog(): Promise<{ packageId: string; url: string; versions: string }[]> {
    const fetched: { packageId: string; url: string; versions: string }[] = [];
    const index = await fetchOnlineJson(SERVICE_INDEX);
    const resources: any[] = Array.isArray(index?.resources) ? index.resources : [];
    const resource = resources.find((item: any) =>
        typeof item?.["@type"] === "string" && item["@type"].startsWith("VulnerabilityInfo")
    );
    const indexUrl = resource?.["@id"];
    if (typeof indexUrl !== "string" || !indexUrl.startsWith("https://")) {
        throw new Error("No VulnerabilityInfo source.");
    }

    const pages = await fetchOnlineJson(indexUrl);
    if (!Array.isArray(pages)) {
        throw new Error("Vulnerability index is not an array.");
    }

    for (const page of pages as any[]) {
        const pageUrl = page?.["@id"];
        if (typeof pageUrl !== "string" || !pageUrl.startsWith("https://")) {
            continue;
        }

        fetched.push(...parseVulnerabilityData(await fetchOnlineJson(pageUrl)));
    }
    return fetched;
}


function advisoryKey(url: string): string {
    const match = url.match(/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i);
    return match ? match[0].toLowerCase() : url.trim().replace(/\/+$/, "").toLowerCase();
}
