import { logger } from "../utils/logger";
import { firstFixedFromRanges, versionInsideRange } from "../utils/nugetAudit";

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
}

export function loadAdvisoryCatalog(): Promise<void> {
    if (!pending) {
        pending = fetchCatalog()
            .then(() => {
                ready = true;
                logger.info("Advisory record is ready.");
            })
            .catch((error) => {
                pending = undefined;
                ready = false;
                throw error;
            });
    }

    return pending;
}

async function fetchCatalog(): Promise<void> {
    const index = await fetchJson(SERVICE_INDEX);
    const resources: any[] = Array.isArray(index?.resources) ? index.resources : [];
    const resource = resources.find((item: any) =>
        typeof item?.["@type"] === "string" && item["@type"].startsWith("VulnerabilityInfo")
    );
    const indexUrl = resource?.["@id"];
    if (!indexUrl) {
        throw new Error("No VulnerabilityInfo source.");
    }

    const pages = await fetchJson(indexUrl);
    if (!Array.isArray(pages)) {
        throw new Error("Vulnerability index is not an array.");
    }

    for (const page of pages as any[]) {
        const pageUrl = page?.["@id"];
        if (typeof pageUrl !== "string" || !pageUrl.startsWith("https://")) {
            continue;
        }

        const data = await fetchJson(pageUrl);
        if (!data || Array.isArray(data)) {
            continue;
        }

        for (const [packageId, items] of Object.entries(data)) {
            if (!Array.isArray(items)) {
                continue;
            }
            const next: AdvisoryRecord[] = [];
            for (const item of items as any[]) {
                if (item && typeof item.url === "string" && typeof item.versions === "string") {
                    next.push({ url: item.url, versions: item.versions });
                }
            }
            records.set(packageId.toLowerCase(), next);
        }
    }
}

async function fetchJson(url: string): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
        const response = await fetch(url, {
            headers: { Accept: "application/json" },
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(`${response.status} ${url}`);
        }
        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}

function advisoryKey(url: string): string {
    const match = url.match(/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i);
    return match ? match[0].toLowerCase() : url.trim().replace(/\/+$/, "").toLowerCase();
}
