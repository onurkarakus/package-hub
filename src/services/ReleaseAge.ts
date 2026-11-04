import { logger } from "../utils/logger";
import { publishedFrom, readLocalPublishedDates } from "./NuGetLocalCache";
import { ScanState } from "./ScanState";
import { minimumReleaseAgeDays, onlineLookupsEnabled } from "./Settings";
import { fetchOnlineJson } from "./OnlineFetch";

const DAY_MS = 24 * 60 * 60 * 1000;
const published = new Map<string, Date | null>();

export type ReleaseAgeSource = "local" | "online";
const sources = new Map<string, ReleaseAgeSource>();

export function publishedAt(packageId: string, version: string): Date | undefined {
    const value = published.get(ageKey(packageId, version));
    return value instanceof Date ? value : undefined;
}

export function releaseIsMature(
    publishedOn: Date | undefined,
    minimumDays: number,
    now = Date.now()
): boolean {
    if (typeof minimumDays !== "number" || !Number.isFinite(minimumDays) || minimumDays <= 0) {
        return true;
    }
    if (!publishedOn || Number.isNaN(publishedOn.getTime())) {
        return true;
    }
    return publishedOn.getTime() <= now - minimumDays * DAY_MS;
}

export function latestReleasePreferred(packageId: string, version: string): boolean {
    return releaseIsMature(publishedAt(packageId, version), minimumReleaseAgeDays());
}

/**
 * Explains why the release age gate could not be checked, or undefined when it
 * could (or when the gate is off).
 */
export function releaseAgeNotice(
    packageId: string,
    version: string,
    minimumDays = minimumReleaseAgeDays(),
    online = onlineLookupsEnabled()
): string | undefined {
    if (minimumDays <= 0 || publishedAt(packageId, version)) {
        return undefined;
    }
    return online
        ? `The publish date of ${packageId} ${version} is unknown, so the ${minimumDays}-day age gate was not applied.`
        : `The publish date of ${packageId} ${version} is not in the local NuGet cache, so the ${minimumDays}-day age gate was not applied. Turn on packageHub.onlineLookups to ask nuget.org.`;
}

export function clearReleaseAges(): void {
    published.clear();
    sources.clear();
}

/**
 * Reads publish dates for every newer version the scan found.
 * Local first: the registration data dotnet cached while it listed outdated
 * packages. Only with packageHub.onlineLookups on does PackageHub ask nuget.org
 * for the dates that are still missing.
 */
export async function loadReleaseAges(cacheRoot: string | undefined): Promise<{ local: number; online: number; missing: number }> {
    const targets = releaseTargets();
    let local = 0;
    let online = 0;
    const missing: { id: string; version: string }[] = [];
    const datesById = new Map<string, Map<string, Date>>();

    for (const target of targets) {
        const key = ageKey(target.id, target.version);
        if (published.get(key) instanceof Date) {
            continue;
        }
        let dates = datesById.get(target.id.toLowerCase());
        if (!dates && cacheRoot) {
            dates = await readLocalPublishedDates(cacheRoot, target.id);
            datesById.set(target.id.toLowerCase(), dates);
        }
        const date = dates ? publishedFrom(dates, target.version) : undefined;
        if (date) {
            published.set(key, date);
            sources.set(key, "local");
            local += 1;
        } else {
            missing.push(target);
        }
    }

    if (missing.length > 0 && onlineLookupsEnabled()) {
        for (let index = 0; index < missing.length; index += 4) {
            const batch = missing.slice(index, index + 4);
            const results = await Promise.all(batch.map((target) => loadOnline(target)));
            online += results.filter(Boolean).length;
        }
    } else if (missing.length > 0 && minimumReleaseAgeDays() > 0) {
        logger.info(`${missing.length} publish dates are not in the local NuGet cache. packageHub.onlineLookups is off, so they were not looked up.`);
    }

    return { local, online, missing: missing.length - online };
}

function releaseTargets(): { id: string; version: string }[] {
    const found = new Map<string, { id: string; version: string }>();
    for (const pkg of [...ScanState.getAllVulnerable(), ...ScanState.getOutDated()]) {
        for (const version of [pkg.latestVersion, pkg.highestPatch]) {
            if (!pkg.id || !version) {
                continue;
            }
            const key = ageKey(pkg.id, version);
            if (!found.has(key)) {
                found.set(key, { id: pkg.id, version });
            }
        }
    }
    return [...found.values()];
}

/**
 * Opt-in only (packageHub.onlineLookups). Reads one registration leaf from
 * nuget.org.
 */
async function loadOnline(target: { id: string; version: string }): Promise<boolean> {
    const key = ageKey(target.id, target.version);
    try {
        const data = await fetchOnlineJson(leafUrl(target.id, target.version));
        const date = readPublished(data?.published);
        published.set(key, date || null);
        if (date) {
            sources.set(key, "online");
        }
        return !!date;
    } catch (error: any) {
        published.set(key, null);
        logger.info(`Could not read the publish date of ${target.id} ${target.version}: ${error?.message || error}`);
        return false;
    }
}

function readPublished(value: unknown): Date | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 2000) {
        return undefined;
    }
    return date;
}

function leafUrl(packageId: string, version: string): string {
    const id = encodeURIComponent(packageId.trim().toLowerCase());
    const ver = encodeURIComponent(version.trim().toLowerCase());
    return `https://api.nuget.org/v3/registration5-gz-semver2/${id}/${ver}.json`;
}

function ageKey(packageId: string, version: string): string {
    return `${packageId.trim().toLowerCase()}\n${version.trim().toLowerCase()}`;
}

